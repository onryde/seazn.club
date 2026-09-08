# Stream Overlay W1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the transparent per-fixture overlay page, its pure projection, the stream-link write path and the organiser panel, so a club can put seazn's live score inside its own OBS broadcast for every sport the engine scores.

**Architecture:** One client transport (`useLiveFixture`, lifted out of `LiveScore`) feeds one pure projection (`overlayModel`) that eleven sports share; a THEME REGISTRY (`OVERLAY_THEMES`, owner answer 18 / Q7) whose two day-one entries are the presentational skins `OverlayBar` and `OverlayBug` renders it at a native 1920×1080 canvas scaled with `transform: scale(min(vw/1920, vh/1080))`, themed by `sportThemeStyle(sportKey)` so the overlay inherits the pad's own palettes. A new `fixtures.stream_url` column, appended to `public_fixtures_v`, is written by `PUT /api/v1/fixtures/{id}/stream` and read by the public match page's "Watch live" link; both the overlay route and the organiser panel are gated server-side on the `streaming.overlay` entitlement, which no plan grants.

**Tech Stack:** Next.js (App Router, RSC + client islands), React 19.2.4, TypeScript, Tailwind v4 + `app/globals.css` custom properties, Zod 4, postgres.js + Flyway migrations, vitest (`environment: "node"`), Playwright, `scripts/smoke.ts`.

**Canvas (owner-reviewed, the visual authority):**
https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 —
artboards "A · Broadcast bar" and "B · Corner bug" (the two registry entries
this wave ships), "A across sports" and "B across sports" (football, tennis,
badminton and volleyball in their real palettes), "Moments" (W2), "How fans
see it on a phone" (the legibility test behind `_THEMES.md` §7), "What the
club sets up" (the OBS flow), and "Organiser console: Stream this match" plus
"Same panel at 390" (Task 6's target). Open it before building any surface;
`_THEMES.md` holds the same design as numbers.

**Spec:** `docs/superpowers/specs/2026-09-07-streaming-programme-design.md` — the design of record (supersedes `2026-09-05-stream-overlay-design.md`, which stays for the canvas links). §3 is Tier A as this plan builds it; §3.2 the endpoint contract Task 0 now implements; §5.1/§5.3 the two keys and the Phone tab gate Task 4 and Task 6 read; §9a the patterns every task names; §13 the findings that moved this plan's pins.
**AMENDED 2026-09-07 @ `fb99bbd4c`** (annotations "(re-pinned 2026-09-07 @ fb99bbd4c)" mark every moved pin): Task 0 is the overlay endpoint over `foldFixture` (zero engine edits); Task 1's hook is generic over `{ fetcher, delayMs? }`; Task 2's readers take the endpoint's shape and the clock is the STAGE's 1 Hz concern; migrations V400/V401 with BOTH keys; fonts reuse `lib/fonts.ts`; the panel mounts in `desk/run-sheet-row.tsx` with an OBS tab and a Phone tab; the visual gate is T1b's manifest; `WALKTHROUGH_SPECS` exists and is edited in Task 8 directly.
**Sibling plan (T1 — lands FIRST; this plan imports its `tokens.ts`, extends its `contrast.test.ts`, appends to its manifest):** `docs/superpowers/plans/2026-09-07-streaming-t1.md`
**Wave prompt (rulings win over this plan; task ORDER below wins):** `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/W1-step-one.md` (corrected in place by T1 Task 0)
**Standing rules R1–R17:** `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_RULES.md`
**Binding design values:** `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md`
**Pinned symbols:** `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`
**Sibling wave (keep names/types compatible):** `docs/superpowers/plans/2026-09-05-stream-overlay-w2-moments.md`

## Global Constraints

- `pnpm`, never `npm install` — `npm install` fails in this repo.
- Every user-facing string lands in all four dictionaries (`apps/web/src/dictionaries/{en,fr,es,nl}/`), then `pnpm i18n:gen-keys` (`package.json:39`); `apps/web/src/lib/i18n-keys.ts` is GENERATED — never hand-edited (R14).
- Migration numbering is flat across `db/migration/**` (`db/flyway.toml:6`). Highest on `main` at `fb99bbd4c` is **`V399__stats_player_career_split.sql`** (re-pinned 2026-09-07 @ fb99bbd4c — the 09-05 text said V391, the 09-06 documents V398; both were taken by the time they were read), so this plan uses **V400** (`stream_url`) and **V401** (`streaming_entitlements`, BOTH keys); run `ls db/migration/deltas | sort -V | tail -1` at Task 3 Step 6 and AMEND the unmerged files to the next free numbers rather than correcting forward (R10). Record the landed numbers in `_INDEX.md`.
- OpenAPI: the new route goes into `ROUTES` (`apps/web/src/server/api-v1/openapi.ts:57`, neighbour `PATCH /fixtures/{id}` at `:142`) in the same change, then `npm run openapi:gen` (`package.json:45`) and both generated files are committed. CI's drift check is a `ci.yml` step (`:94-98`), not a hook (R7).
- Entitlement key `streaming.overlay` is granted by **no plan**, and is **NOT added to `ENTITLEMENT_DOMAINS`** (`apps/web/src/lib/entitlement-domains.ts:5`) — that omission is the mechanism that keeps it off `/pricing`, because `buildPricingSections` (`apps/web/src/lib/pricing-matrix.ts:191,199`) renders only listed keys (R1).
- `create or replace view public_fixtures_v` may only APPEND, so `stream_url` is the LAST column of a FULL redefinition copied from `db/migration/deltas/V369__public_fixtures_round_role.sql:18` (R6). (Re-pinned 2026-09-07 @ fb99bbd4c: STILL V369 — `grep -al public_fixtures_v db/migration/deltas/*.sql | sort -V | tail -1` — the 09-07 design's RP3 "`V362:22`" is the 09-06 scout's stale pin, recorded as finding FS10 in `_INDEX.md`; this plan is right and the design's row is corrected there.)
- Judge vitest green ONLY from `--reporter=json --outputFile=<file>` — read `numPassedTests`/`numTotalTests`/`numFailedTests`, and confirm `.testResults[].name` resolves under `/Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay`. `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to COLLECT and swallows exit codes.
- **Baseline:** on the fresh `ovl` DB the full `apps/web` suite is **13962 passing / 14041 total, 5 red** — 3 in `schedule-build-honours-locks.test.ts` (placement service not running; environmental) and 2 in `pass-scoping-guard.test.ts` (unclassified). Neither touches a W1 file. Every task gate compares against **this baseline**, not against zero.
- DB-backed tests need `DATABASE_URL`. Stand the env up from THIS worktree: `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label ovl`; `eval` is refused by the session guard, so read `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label ovl` as a plain call and set the printed values inline on the command (`DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/seazn_ovl DATABASE_SSL=disable`). `db:apply` alone is NOT a fresh schema — `sync:sports` must have run.
- Playwright runs from `apps/web` with `PLAYWRIGHT_BASE` and `E2E_PROD_TARGET` set (`seazn-env.sh up --label ovl --server`); `seazn-env.sh rebuild --label ovl` after every code change — `up --server` again is a no-op that serves the OLD bundle; probe `_buildManifest.js`, not `/api/health`, and re-read the port.
- Shell cwd resets between calls: prefix every command with `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay &&` in the SAME call. Never `git stash` in this worktree. Run git as SEPARATE plain `/usr/bin/git` calls. Use `grep -a`.
- One DOM branched with `max-md:*` / `md:hidden`, phone first, identical control SET at 320 and 1280, no horizontal scroll at 320/360/375/390/430/768/834 (R15). `/\bmd:hidden\b/` also matches inside `max-md:hidden` — anchor assertions on `\s...hidden"`.
- Motion is `transform`/`opacity` only, exactly three motions in W1, nothing animates on mount, `prefers-reduced-motion` disables tick and breath (R13, `_THEMES.md` §6).
- Every subagent dispatch passes `model: opus` explicitly (`_RULES.md` §Agents, owner ruling 2026-09-05).
- JSON reports go to `/tmp/ovl-w1/` — `mkdir -p /tmp/ovl-w1` once. A second concurrent session must vary the directory (a bare `/tmp` path collides across sessions).
- **Task numbering (owner answers, 2026-09-06).** The four answers folded in below added ONE task, and it is numbered **Task 0** deliberately: Tasks 1–8 keep the numbers that `_INDEX.md`, `_STATE.md`, the W1 prompt's scopes and the W2 plan already cite, so no cross-reference anywhere moved. Execution order is 0, 1, 2, 3, 4, 5, 6, 7, 8.
- **Transport (owner answer 14 / Q3): "we are using supabase realtime."** The overlay subscribes to the SAME Supabase private channel the public match page uses — no second transport, no overlay-only poll interval. `/api/v1/public/fixtures/[id]/realtime-token` 403s without the `realtime` entitlement and the client then falls back to the 15 s poll, which on a live broadcast is a score that lags the picture. So the test org's override row grants **both** `streaming.overlay` and `realtime` (Task 4), and Task 4's test asserts both. Whether every plan that eventually grants one must grant the other is a PRICING-time decision, deferred alongside Q4 — do not encode that coupling in code.
- **The hiding gate is the per-organisation entitlement override row (owner answer 17 / Q14)** — not a request header (a browser cannot set one on a navigation and OBS sends none), not a preview cookie, not an environment flag. A viewer whose org does not hold `streaming.overlay` gets exactly three things: `notFound()` (404) on `/overlay/fixtures/[id]`, no panel on the division page, and nothing on `/pricing`. No task in this plan may invent a second gate.
- **Themes are a REGISTRY, not a two-value union (owner answer 18 / Q7):** *"we will have multiple theme per sports so make it abstract and use can choose for now apply the default one."* `OVERLAY_THEMES` (`components/overlay/theme-registry.ts`, Task 5 Steps 6a–6d) keys an `OverlayThemeDef` by `ThemeId` and holds `bar` and `bug` on day one. **A third theme is one registry entry plus one component** — never an edit to the route (Task 5's page passes `resolveTheme(...).id` and nothing else), never an edit to the panel (Task 6's tabs map over `themesForSport(sportKey)`), never an edit to the model (Task 2 does not know a theme exists). `?style=<themeId>` is validated against the registry AND against the entry's `sports`; an unknown, misspelt or unsuitable id falls back to `defaultThemeFor(sportKey)` and **never throws**, because an OBS browser source cannot be asked to correct a typo mid-match. The per-sport default is exactly what it was — cricket `bar`, every other sport `bug` — but it now lives in one named function instead of an inline boolean. No task may reintroduce a `"bar" | "bug"` union, an `overlayStyleFor`, or a `props.style === "bar" ? … : …` branch.
- **Sponsor logos are not in this wave, and not in W2 (owner answer 20 / Q9: *"ok for own wave as put it last"*).** They become their own wave, scheduled LAST in the programme, after W1 and W2. Nothing in this plan designs, reserves a slot for, or leaves a seam for them — a reserved-but-empty slab is an inert seam, and the sizing, placement and per-tier rules are that wave's job.
- Do NOT touch: `components/v2/scorepad/**` (read `sport-theme.ts`, import from it, never edit), **the whole of `packages/engine`** (amended 2026-09-07: Task 0 reads the folded STATE the engine already holds; there is no engine edit anywhere in this programme, and `/usr/bin/git status --porcelain packages` must print nothing at every gate), `components/v2/fixture-console.tsx`, `ENTITLEMENT_DOMAINS`, other keys' matrix rows, any pricing surface, `LiveScore`'s render and `Props`, `proxy.ts` CSP, `app/embed/**`, `app/slideshow/**`, `.github/workflows/e2e.yml`, T1b's harness files (`e2e/visual/capture.spec.ts`, `asserts.ts`, `manifest.ts` — this wave appends to `manifest.json` and adds one seed kind to `seeds.ts`, nothing else), and anything in `desk/run-sheet-row.tsx` beyond one import plus one conditional line, or in `desk/run-sheet.tsx` / `stages-panel.tsx` beyond threading two props (R11; re-pinned 2026-09-07 @ fb99bbd4c — `FixtureLine` was retired by desk W2 #725; **desk W3** `feat/competition-desk-w3-band-and-phone` is editing `run-sheet-row.tsx` now, so Task 6 rebases after any W3 merge and never races it).
- **Owner checklist (`docs/superpowers/RULES.md` §"Owner checklist (2026-09-07)")** binds every task below; each task's acceptance names the rows it satisfies, and the reviewer checks the rows, not the prose.
- **Patterns this plan invokes, with exemplars (design §9a):** parse → authorize → delegate (`lib/http.ts:69`, `auth.ts:352`, `app/api/v1/fixtures/[id]/route.ts`); zod at `server/api-v1/schemas.ts`; privacy folds in VIEWS (`public_fixtures_v`); fire-and-forget side channels (`fireDivisionRevalidate`); one authority per fact (`resolveVenueTz`, `fixtureStatusLabel`/`VOID_STATUSES`, the five `lib/public-site.ts` derivations, `globals.css` for colour via T1's `tokens.ts`); registry over branching (`OVERLAY_THEMES`); pure projections with strings via `msg` (`overlayModel`); deny by default (`notFound()`, exact-host allowlist); the client never decides (`hasFeature` on the page and the division page); one DOM branched for phone.

## File Structure

| File | Create / Modify | Responsibility |
|---|---|---|
| `apps/web/src/server/public-site/data.ts` | Modify (`getPublicFixture`, `:701-760` @ fb99bbd4c) | `venueTz` on the return — `resolveVenueTz(divisionTz, orgTz)`, one zone per fixture. |
| `apps/web/src/components/public-site/live-score-data.ts` | Modify (after `LiveFixtureData`) | `OverlayLiveData` (design §3.2, verbatim) + `fetchOverlayFixture` (amended 2026-09-07). |
| `apps/web/src/server/overlay/project.ts` | Create | `projectOverlayLiveData` — pure: folded state → the contract, by shape, no sport-key branch. |
| `apps/web/src/server/overlay/__tests__/project.test.ts` | Create | Real football and cricket folds through the real modules; every other sport yields neither field. |
| `apps/web/src/server/overlay/load.ts` | Create | `loadOverlayLiveData` — cached public row + venue zone + `foldFixture` inside `unstable_cache` keyed on `last_seq`. |
| `apps/web/src/server/overlay/__tests__/load.test.ts` | Create | The cost claim: fold ≤ 1× per `last_seq`. |
| `apps/web/src/app/api/v1/public/fixtures/[id]/overlay/route.ts` | Create | `GET` — the overlay's one poll target; visibility = the view's; no entitlement here. |
| `apps/web/src/components/overlay/tokens.ts` | **Exists from T1** (Task 2 there) | `ROOT_SPORT_DEFAULTS`, `OVERLAY_FIXED`, `paletteFor`, `OVERLAY_PAIR_ROLES` — Task 5 IMPORTS, never re-declares. |
| `apps/web/src/lib/fonts.ts` | Modify (`:8`) | `weight: ["600", "700", "800"]` — the one edit RP8 allows; the overlay layout imports `barlowCondensed`, never remounts `next/font`. |
| `apps/web/src/components/overlay/use-overlay-clock.ts` | Create | The ONE timer: 1 Hz, anchored on `OverlayLiveData.clock`, offset by the hook's `presentationNowOffsetMs`, holds the last value while `clock` is absent (owner ruling 2026-09-06: the clock TICKS in W1). |
| `apps/web/src/components/overlay/__tests__/use-overlay-clock.test.ts` | Create | `renderIsland` + captured `setInterval`: anchors, ticks, re-anchors on push, holds at half-time, offsets under `delayMs`. |
| `apps/web/src/server/public-site/__tests__/public-fixture-venue-tz.test.ts` | Create | DB-backed: division override wins, org fallback, UTC default. |
| `apps/web/src/components/public-site/use-live-fixture.ts` | Create | The ONE public live transport: subscribe-or-poll, lifted verbatim from `live-score.tsx:60-117`. |
| `apps/web/src/components/public-site/__tests__/use-live-fixture.test.tsx` | Create | Hook branches via `renderIsland` + captured `setInterval`. |
| `apps/web/src/components/public-site/live-score.tsx` | Modify (`:8`, `:29`, `:59-117`, `:148`) | Repointed to the hook; render and `Props` unchanged. |
| `apps/web/src/lib/public-site.ts` | Modify (append after `:378`) | `battingEntrantId`, `chaseNeed` (summary readers) and `chaseBalls` (reads `OverlayLiveData.cricket`, amended 2026-09-07) — `matchClock` is GONE: the clock is the stage's timer, formatted by `formatClock` in `overlay-model.ts`. |
| `apps/web/src/lib/__tests__/public-site-overlay-derive.test.ts` | Create | Unit cover for the three readers. |
| `apps/web/src/lib/overlay-model.ts` | Create | Pure projection `overlayModel(input): OverlayModel`; `overlayStartLabel(iso, locale, tz)`; type-only `OverlayMoment` slot for W2. |
| `apps/web/src/lib/__tests__/overlay-model.test.ts` | Create | Eleven sports folded through real modules; empty / decided / led truth table. |
| `apps/web/src/lib/stream-url.ts` | Create | `streamUrlSchema` — https + exact-hostname allowlist, `""` → `null`. |
| `apps/web/src/lib/__tests__/stream-url.test.ts` | Create | Eleven accepted hosts (R16's ten plus `m.youtube.com`, owner answer 16 / Q5); the rejections named in the prompt, look-alike hosts included. |
| `db/migration/deltas/V400__fixture_stream_url.sql` | Create (re-pinned 2026-09-07 @ fb99bbd4c; next free at rebase) | Column + check + full `public_fixtures_v` redefinition with `stream_url` last. |
| `db/migration/deltas/V401__streaming_entitlements.sql` | Create (re-pinned 2026-09-07) | BOTH keys — `streaming.overlay` and `streaming.relay` — `false` on every plan key (dark rollout, design §10.4; the GA flip to §5.1's split is a later migration). |
| `apps/web/src/server/public-site/data.ts` | Modify (`:206`, `:711-716`, new export after `:747`) | `PublicFixture.stream_url`; the fixture SELECT gains it; `publicFixtureSlugs(fixtureId)`. |
| `apps/web/src/server/usecases/public.ts` | Modify (`:263-297`) | `publicFixture()`'s `Pick<>` and SELECT gain `stream_url`. |
| `apps/web/src/server/api-v1/schemas.ts` | Modify (after `:989`) | `PutFixtureStream`, `FixtureStream`. |
| `apps/web/src/server/usecases/fixtures.ts` | Modify (after `:176`) | `setFixtureStreamUrl(auth, id, streamUrl)`. |
| `apps/web/src/server/usecases/__tests__/fixture-stream-url.test.ts` | Create | DB-backed usecase test (`_rig.ts`, `HAS_DB` skip idiom). |
| `apps/web/src/app/api/v1/fixtures/[id]/stream/route.ts` | Create | `PUT` — `parseBody` + `requireResourceAuth(req, "fixture", id, "write")`. |
| `apps/web/src/server/api-v1/openapi.ts` | Modify (after `:142`) | One `ROUTES` entry. |
| `apps/web/src/server/api-v1/key-scopes.ts` | Modify (after `:175`) | One `KEY_ROUTE_RULES` entry (total-classification test demands it). |
| `apps/web/openapi/v1.json`, `apps/web/openapi/v1.public.json` | Modify (generated) | `npm run openapi:gen` output. |
| `apps/web/src/lib/__tests__/entitlement-streaming-overlay.test.ts` | Create | `ENTITLEMENT_DOMAINS` does NOT list the key; DB-backed override flip. |
| `apps/web/src/app/overlay/fixtures/[fixtureId]/layout.tsx` | Create | Nested `<div>` layout: transparent `html, body`, `barlowCondensed` IMPORTED from `@/lib/fonts` (RP8, re-pinned 2026-09-07), cookie banner suppressed. |
| `apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx` | Create | Server: slug resolve → `getPublicFixture` → `hasFeature` → `notFound()`; `robots: { index: false }`. |
| `apps/web/src/components/overlay/theme-registry.ts` | Create | `OverlayThemeDef`, `ThemeId`, `OVERLAY_THEMES`, `defaultThemeFor`, `themesForSport`, `resolveTheme` — the ONE authority for which themes exist, which sports they suit and which one a sport opens on (owner answer 18 / Q7). |
| `apps/web/src/components/overlay/__tests__/theme-registry.test.ts` | Create | Valid id resolves; unknown id falls back; sport-unsuitable id falls back; the fallback is the SPORT's default, not a constant. |
| `apps/web/src/components/overlay/overlay-stage.tsx` | Create | Client island: hook + model + scale + the three motions + `ovl-moment-slot`; renders `OVERLAY_THEMES[props.style].component`. |
| `apps/web/src/components/overlay/overlay-bar.tsx` | Create | Theme A (registry entry `bar`) per `_THEMES.md` §3. |
| `apps/web/src/components/overlay/overlay-bug.tsx` | Create | Theme B (registry entry `bug`) per `_THEMES.md` §4. |
| `apps/web/src/app/globals.css` | Modify (append after `:1022`) | `.ovl-*` rules + the three keyframes + the reduced-motion block. |
| `apps/web/src/components/cookie-consent.tsx` | Modify (`:84` + a `usePathname` guard) | `data-testid="cookie-consent"`, and RENDERS NOTHING under `/overlay/` (owner answer 13). |
| `apps/web/src/components/__tests__/cookie-consent-overlay-segment.test.tsx` | Create | The guard, driven through the component — plus its positive pair. |
| `apps/web/src/components/v2/fixture-stream-panel.tsx` | Create | The organiser panel per `_THEMES.md` §8. |
| `apps/web/src/components/v2/desk/run-sheet-row.tsx` | Modify (beside `data-testid="run-sheet-edit-time"`, `:377` @ fb99bbd4c) | ONE import + ONE conditional line: the `fixture-stream-toggle` and the expander (re-pinned 2026-09-07 — `FixtureLine` in `stages-panel.tsx` was retired by desk W2 #725). |
| `apps/web/src/components/v2/desk/run-sheet.tsx` | Modify (Props `:44-80`, both `<RunSheetRow>` call sites `:261`, `:296`) | Threads `sportKey`, `streamingEntitled`, `relayEntitled`, `openStreamFor` to every row. |
| `apps/web/src/components/v2/stages-panel.tsx` | Modify (Props, the `<RunSheet>` mount `:1167-1183`) | Threads the same props one level up; reads `?stream=<fixtureId>` from the URL for the row to open. |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` | Modify (`:124-138`, `:596`) | `hasFeature(auth.orgId, "streaming.overlay")` into the `Promise.all`; both props passed. |
| `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx` | Modify (above `:175`) | The "Watch live" / "Replay" anchor. |
| `apps/web/src/dictionaries/{en,fr,es,nl}/public.json` | Modify | `overlay.*` keys. |
| `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json` | Modify | `stream.*` keys. |
| `apps/web/src/lib/i18n-keys.ts` | Modify (generated) | `pnpm i18n:gen-keys` output. |
| `apps/web/src/lib/__tests__/overlay-dict-coverage.test.ts` | Create | Every `overlay.*`/`stream.*` key referenced in source exists in all four locales. |
| `apps/web/e2e/walkthrough/stream-overlay.spec.ts` | Create | The wave's e2e (project `walkthrough` by path regex, R9). |
| `apps/web/e2e/visual/seeds.ts` | Modify (one seed kind, `overlay-fixture`) | The entitled org, four short real streams, the "—" fixture and the 404 id — the ONLY harness file this wave touches (amended 2026-09-07; the `OVL_DIR` capture spec is retired). |
| `apps/web/e2e/visual/manifest.json` | Modify (append two groups) | `overlay` (bar + bug × four sports × light + dark, the "—" and 404 states) and `console-panel` (320 / 768 / 1280 / 320 @ 125 %, control-set-equal 320↔1280). |
| `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` | Modify (`WALKTHROUGH_SPECS`) | `stream-overlay.spec.ts` registered (re-pinned 2026-09-07: the list EXISTS on `main` since #723 — Task 8 edits it directly, not post-rebase). |
| `scripts/smoke.ts` | Modify (after `:790`) | `streamOverlaySuite` — overlay 200/404 and the `stream_url` seam end to end. |
| `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md` | Modify | Status rows, landed migration numbers, findings. |

---

### Task 0: The venue zone, and the overlay endpoint over `foldFixture`

> **AMENDED 2026-09-07 (design of record §3.2, §3.3; `_INDEX.md` 2026-09-07
> section).** Steps 2–13 of the original Task 0 — four engine edits, a
> `coarsen` change and four regenerated golden corpora — were marked
> SUPERSEDED on 2026-09-06 and are now REPLACED. Owner answer 19 (Q16) gives
> the overlay its own DATA PATH inside the app, and Q15 closed on evidence
> (2026-09-06, verified in the tree): `foldFixture(tx, fixtureId)`
> (`apps/web/src/server/engine-db/fold.ts:58`, returns the module's WHOLE
> folded state at `:130` over the fine, void-resolved stream) already carries
> football's `phase` / `periods` / `asOf` (`football.ts:566,570,599`) and
> cricket's `legalBalls` / `ballsLimit` (`cricket.ts:436,440`); `grep -arn
> coarsen apps/web/src` returns zero. **Nothing in `packages/engine` is
> touched by this programme.** The Global Constraints' engine carve-out is
> gone; the "Do NOT touch" list now names the engine whole.
>
> What this task now builds, in order: **Step 1–4 unchanged** (the venue
> zone on `getPublicFixture` — a row fact, owed either way); **Steps 5–8** a
> PURE projection `projectOverlayLiveData` from a folded state to the
> `OverlayLiveData` contract, tested by folding REAL football and cricket
> streams through the REAL modules (the same `foldMatch` builder Task 2's
> projection test uses); **Steps 9–12** the loader `loadOverlayLiveData`
> that reads the cached public row, resolves the venue zone, and folds inside
> `unstable_cache` KEYED ON `last_seq` — the fold runs once per ledger
> advance, not once per poll (a spy proves ≤ 1× per `last_seq`); **Step 13**
> the route `GET /api/v1/public/fixtures/[id]/overlay` beside the existing
> public fixture route, plus its OpenAPI row and the client fetcher
> `fetchOverlayFixture`; **Steps 14–17** e2e staging, mutants, gate, commit.
>
> **Why the numbers ride the ENDPOINT and not `ScoreSummary`:** the live
> transport carries `{ status, summary, outcome }` (`live-score-data.ts`), so
> the 2026-09-05 plan smuggled two numbers through the engine's summary at the
> cost of §9.6 exposure and a golden re-baseline. The endpoint reads them off
> the folded STATE the engine already holds, through the engine, changing no
> engine file — and Task 1's hook becomes generic over its fetcher so `LiveScore`
> and the overlay share one transport with two payloads.
>
> **Contract (design §3.2, VERBATIM — the one poll target on every tier):**
>
> ```ts
> interface OverlayLiveData extends LiveFixtureData {   // status, summary, outcome — one authority: match_states
>   lastSeq: number | null;                             // W2's mount-seq
>   venueTz: string;                                    // resolveVenueTz(schedule_settings.tz, org.timezone)
>   clock?: { phase: string; anchorSeconds: number; anchorAtWallMs: number };  // football family, while a play phase is running
>   cricket?: { innings: { runs: number; wickets: number; legalBalls: number; ballsLimit: number | null }[] };
> }
> ```
>
> `clock` is present only while the folded state's `asOf.period === phase`
> (the same staleness guard `footballPosition` applies): during a play phase
> it anchors the stage's 1 Hz tick (Task 5); at half-time and full-time the
> field is ABSENT and the stage HOLDS the last displayed value (`_THEMES.md`
> §6: "stops at half-time, at full-time"). `anchorAtWallMs` is the wall time
> of the LAST active envelope (`folded.active[last].recordedAt`), so a
> viewer joining mid-half sees `anchorSeconds + (now − anchorAtWallMs)`, not
> a frozen stamp.

---

**Files:**
- Create (Test): `apps/web/src/server/public-site/__tests__/public-fixture-venue-tz.test.ts`
- Modify: `apps/web/src/server/public-site/data.ts` — `getPublicFixture`'s return type and its cached block (`:701-760` @ fb99bbd4c)
- Modify: `apps/web/src/components/public-site/live-score-data.ts` — `OverlayLiveData` type + `fetchOverlayFixture`
- Create: `apps/web/src/server/overlay/project.ts` — `projectOverlayLiveData` (pure)
- Create (Test): `apps/web/src/server/overlay/__tests__/project.test.ts` — real modules, real folds
- Create: `apps/web/src/server/overlay/load.ts` — `loadOverlayLiveData` (row + venue zone + cached fold)
- Create (Test): `apps/web/src/server/overlay/__tests__/load.test.ts` — the ≤ 1× per `last_seq` spy
- Create: `apps/web/src/app/api/v1/public/fixtures/[id]/overlay/route.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts` — one `ROUTES` row beside `/public/fixtures/{id}` (`:200`)
- Generated: `apps/web/openapi/v1.json`, `apps/web/openapi/v1.public.json`

**Interfaces:**
- Consumes: `resolveVenueTz(divisionTz, orgTz): string` (`apps/web/src/lib/tz.ts:44`); `foldFixture(tx: Tx, fixtureId: string): Promise<FoldedFixture | null>` (`server/engine-db/fold.ts:58`; `FoldedFixture { fixtureId, lastSeq, state: unknown, summary, outcome, active: readonly EventEnvelope[] }` `:17-28`); `sql.begin(async (tx) => …)` (`lib/db.ts:221`; precedent `usecases/registration-submit.ts:609` — a plain read transaction, no tenant role, the public views already fold privacy); `publicFixture(fixtureId): Promise<unknown>` (`usecases/public.ts:279` — the cached public row `{ status, outcome, summary, last_seq, … }`), `publicRateLimit(req)`, `PUBLIC_CACHE_CONTROL`; `v1`, `reply` (`server/api-v1/http.ts:124,96`); `unstable_cache(fn, keys, { revalidate })` from `next/cache` (usage at `data.ts:720-753`); `api<T>(path)` (`lib/client.ts`, unwraps `data` once); `FootballState.phase/asOf` (`football.ts:566,599`, `asOf?: { period: string; elapsed: number }`), `CricketState.innings[]` (`cricket.ts:432-447,463`); `foldMatch`, `defaultLineupPair`, `makeEnvelope`, `builtinModules` (the Task 2 test's imports from `@seazn/engine/core`, `@seazn/engine/testkit`, `@seazn/engine/sports`).
- Produces:
  - `getPublicFixture(...)` gains `venueTz: string` on its resolved object (Steps 1–4, unchanged)
  - `export interface OverlayLiveData extends LiveFixtureData { lastSeq: number | null; venueTz: string; clock?: { phase: string; anchorSeconds: number; anchorAtWallMs: number }; cricket?: { innings: { runs: number; wickets: number; legalBalls: number; ballsLimit: number | null }[] } }` and `export async function fetchOverlayFixture(fixtureId: string): Promise<OverlayLiveData>` (`live-score-data.ts`)
  - `export function projectOverlayLiveData(input: { row: { status: string; summary: LiveFixtureData["summary"]; outcome: LiveFixtureData["outcome"]; last_seq: number | null }; folded: FoldedFixture | null; venueTz: string }): OverlayLiveData` (`server/overlay/project.ts`)
  - `export async function loadOverlayLiveData(fixtureId: string): Promise<OverlayLiveData>` (`server/overlay/load.ts`; throws `HttpError(404)` through `publicFixture` when the fixture is not publicly visible)
  - `GET /api/v1/public/fixtures/{id}/overlay` → `{ ok: true, data: OverlayLiveData }` with `PUBLIC_CACHE_CONTROL`

> **Shape decision — the venue zone rides as a raw IANA string, and the LABEL is
> formatted by the server component that already holds the locale.** Not both, and
> not a pre-formatted label alone. Reasons: Task 2's deviation 3 (kept) puts
> `Intl` formatting outside the pure model, and the only consumer that needs the
> zone is the overlay page, which is a server component holding `locale` already;
> a pre-formatted label alone would fix the format for every future consumer and
> could not be re-rendered in another locale from `?lang=`. `overlayStartLabel`
> (Task 2) is where the two meet.
>
> **`resolveVenueTz` rather than a second answer.** `getPublicDivision` (`data.ts:665-670`)
> splices the SQL mirror `coalesce(ss.tz, o.timezone, 'UTC')` inline because a
> string helper cannot go into a postgres.js tagged template. This query has both
> columns in hand, so it folds them through the TS authority instead. **Trap,
> asserted below:** `schedule_settings.tz` is `text not null default 'UTC'`
> (`V219__schedule_settings.sql:8`), so a division row that exists with the
> default SHADOWS the org's zone — in both the SQL mirror and `resolveVenueTz`.
> "Org fallback" therefore means NO `schedule_settings` row, and the test seeds
> it that way rather than writing `'UTC'` and expecting inheritance.

- [ ] **Step 1: Write the failing venue-zone test.** Create `apps/web/src/server/public-site/__tests__/public-fixture-venue-tz.test.ts`:

```ts
// Owner answer 12 (Q1): the public fixture payload carries the VENUE zone, so
// a pre-match overlay prints a start time an Indian or Dutch club audience
// recognises instead of UTC.
//
// The competition-desk programme's ruling is "one zone per fixture" and its
// resolver is `resolveVenueTz` (lib/tz.ts:43) — the VENUE lane, never the
// personal lane. This test pins the three branches THROUGH getPublicFixture,
// not through the helper (the helper already has its own unit cover): the
// claim is about what the payload carries, and a helper test cannot see a
// query that forgot to select `organizations.timezone`.
//
// unstable_cache is a Next server-runtime API — passthrough under vitest, the
// same double this directory's data-court-venue-names.test.ts uses. Real
// Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { getPublicFixture } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

interface Seeded {
  orgId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  divisionId: string;
  fixtureId: string;
}

/**
 * A public org / competition / division / fixture, seeded by direct insert.
 *
 * LIFT `seed()` from `data-court-venue-names.test.ts` in this same directory
 * rather than re-deriving the column list — that file already seeds exactly
 * this shape (public competition, live division, one fixture) and is the
 * working reference for which columns are NOT NULL. Drop its venue/court
 * inserts, which this test does not need, and return the ids below.
 */
async function seedPublicFixture(orgTz: string | null): Promise<Seeded> {
  /* … lifted seed … */
  throw new Error("lift from data-court-venue-names.test.ts");
}

const seeded: string[] = [];
afterAll(async () => {
  for (const orgId of seeded) await sql`delete from organizations where id = ${orgId}`;
});

describe.skipIf(!HAS_DB)("getPublicFixture carries the venue zone", () => {
  it("falls back to the organisation's zone when the division has no schedule_settings row", async () => {
    const s = await seedPublicFixture("Asia/Kolkata");
    seeded.push(s.orgId);
    // Deliberately NO schedule_settings row: `tz` is `not null default 'UTC'`
    // (V219:8), so a row that merely exists would SHADOW the org zone, and a
    // test that wrote 'UTC' here would be asserting the wrong branch.
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(data, "the seeded fixture must be publicly visible").not.toBeNull();
    expect(
      data!.venueTz,
      "a UTC label is the wrong time for this club — that is the whole point of the field",
    ).toBe("Asia/Kolkata");
    expect(data!.venueTz).not.toBe("UTC");
  });

  it("the division's own override wins over the organisation's zone", async () => {
    const s = await seedPublicFixture("Asia/Kolkata");
    seeded.push(s.orgId);
    await sql`
      insert into schedule_settings (division_id, org_id, tz)
      values (${s.divisionId}, ${s.orgId}, 'Europe/Amsterdam')
      on conflict (division_id) do update set tz = excluded.tz`;
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(
      data!.venueTz,
      "a London organiser running an event in Malaga — the venue lane's whole reason to exist",
    ).toBe("Europe/Amsterdam");
  });

  it("is UTC when neither is set, and never a personal or browser zone", async () => {
    const s = await seedPublicFixture(null);
    seeded.push(s.orgId);
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(data!.venueTz).toBe("UTC");
  });

  it("rejects a stored zone Intl does not accept rather than passing it through", async () => {
    // `resolveVenueTz` validates with Intl.DateTimeFormat construction, so a
    // legacy/typo'd zone degrades to the next lane instead of reaching
    // Intl.DateTimeFormat({ timeZone }) in the page and throwing a RangeError
    // that would 500 the overlay mid-broadcast.
    const s = await seedPublicFixture("Mars/Olympus_Mons");
    seeded.push(s.orgId);
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(data!.venueTz).toBe("UTC");
  });
});
```

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl DATABASE_SSL=disable npx vitest run src/server/public-site/__tests__/public-fixture-venue-tz.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t0a-red.json`
  Expected: a COLLECTION failure first — `Property 'venueTz' does not exist on type` is a tsc error, not a vitest one, so what vitest actually reports is four failures of the form `expected undefined to be 'Asia/Kolkata'`. `numTotalTests: 4`, `numFailedTests: 4`. Read the JSON; do not judge from a wrapper summary.

- [ ] **Step 3: Add `venueTz` to `getPublicFixture`.** In `apps/web/src/server/public-site/data.ts`: add `import { resolveVenueTz } from "@/lib/tz";` beside the existing imports, widen the function's declared return object with `venueTz: string;`, and inside the `unstable_cache` block, after the `realtime` query:

```ts
      // Venue lane (V305), "one zone per fixture" — the division's own
      // `schedule_settings.tz` override, else the ORGANISATION's zone, else
      // UTC. Resolved through `resolveVenueTz` (lib/tz.ts:43) rather than the
      // `coalesce(ss.tz, o.timezone, 'UTC')` mirror `getPublicDivision` above
      // splices inline: that mirror exists because a string helper cannot be
      // spliced into a postgres.js tagged template, and this query has both
      // columns in hand, so the TS authority applies directly.
      //
      // NEVER `pickTimezone` and never the `seazn_tz` cookie: a London-based
      // organiser can run an event in Malaga, and the overlay is watched by an
      // audience in neither.
      const [zone] = await sql<{ division_tz: string | null; org_tz: string | null }[]>`
        select ss.tz as division_tz, o.timezone as org_tz
        from divisions d
        left join schedule_settings ss on ss.division_id = d.id
        left join organizations o on o.id = d.org_id
        where d.id = ${division.id}`;
```

  and add `venueTz: resolveVenueTz(zone?.division_tz, zone?.org_tz),` to the object the cached block returns, and to the final `return { org: shell.org, competition: shell.competition, division, ...detail };` spread (it rides in `detail`, so no edit is needed there — confirm by reading, not by assuming).

- [ ] **Step 4: Run — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl DATABASE_SSL=disable npx vitest run src/server/public-site --reporter=json --outputFile=/tmp/ovl-w1/t0a-green.json`
  Expected: `numFailedTests: 0`; the new file contributes 4; `data-court-venue-names.test.ts`, `pass-scope-public-realtime.test.ts` and `player-stats-public.test.ts` pass with ZERO edits. Confirm every `.testResults[].name` resolves under the worktree.

- [ ] **Step 5: Write the failing projection test.** Create `apps/web/src/server/overlay/__tests__/project.test.ts`:

```ts
// `projectOverlayLiveData` — the folded state → the overlay's wire contract
// (design §3.2). Every case folds a SHORT REAL ledger through the REAL module
// (`foldMatch`, packages/engine/src/core/events.ts:445, with
// `defaultLineupPair`/`makeEnvelope` from `@seazn/engine/testkit`) — the same
// builder Task 2's overlay-model.test.ts uses — so the two numbers the
// overlay needs are read off the state the ENGINE produced, never off a
// hand-typed object that happens to have the right keys.
//
// Pure: no DB. `FoldedFixture` is assembled from the fold's own outputs.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { projectOverlayLiveData } from "../project";
import type { FoldedFixture } from "@/server/engine-db/fold";

const moduleFor = (key: string) => {
  const m = builtinModules.find((mod) => mod.key === key);
  if (!m) throw new Error(`no builtin module for "${key}"`);
  return m;
};

/** Folds `stream` through the real module and returns what foldFixture would. */
function folded(key: string, stream: readonly (readonly [string, unknown])[], recordedAt = "2026-09-07T14:00:00.000Z"): FoldedFixture {
  const mod = moduleFor(key);
  const cfg = mod.configSchema.parse({});
  const lineups = defaultLineupPair(mod.positions);
  const events: EventEnvelope[] = stream.map(([type, p], i) => ({
    ...makeEnvelope(i, { type, payload: p } as never),
    recordedAt,
  }));
  const state = foldMatch(mod as never, cfg as never, lineups, events);
  const m = mod as unknown as { summary: (s: unknown) => FoldedFixture["summary"]; outcome?: (s: unknown) => FoldedFixture["outcome"] };
  return {
    fixtureId: "fx-1",
    lastSeq: events.length,
    state,
    summary: m.summary(state),
    outcome: m.outcome ? m.outcome(state) : null,
    active: events,
  };
}

const ROW = (last_seq: number | null, status = "in_play") => ({ status, summary: { headline: "x" }, outcome: null, last_seq });

describe("projectOverlayLiveData", () => {
  it("carries the row's snapshot fields and the venue zone, and lastSeq from the ROW (one authority: match_states)", () => {
    const out = projectOverlayLiveData({ row: ROW(7), folded: null, venueTz: "Asia/Kolkata" });
    expect(out.status).toBe("in_play");
    expect(out.summary).toEqual({ headline: "x" });
    expect(out.outcome).toBeNull();
    expect(out.lastSeq).toBe(7);
    expect(out.venueTz).toBe("Asia/Kolkata");
    expect(out.clock).toBeUndefined();
    expect(out.cricket).toBeUndefined();
  });

  it("football: a stamped goal in a running half anchors the clock at the stamp, on the last event's wall time", () => {
    const f = folded("football", [
      ["core.start", {}],
      ["football.goal", { by: "home", at: { period: "H1", elapsed: 761 } }],
    ]);
    const out = projectOverlayLiveData({ row: ROW(2), folded: f, venueTz: "UTC" });
    expect(out.clock).toEqual({ phase: "H1", anchorSeconds: 761, anchorAtWallMs: Date.parse("2026-09-07T14:00:00.000Z") });
    expect(out.cricket).toBeUndefined();
  });

  it("football: between periods the clock is ABSENT (the stage holds the last value), never a stale stamp", () => {
    // H1's closing whistle carries an H1 stamp; once HT/H2 begins the stamp
    // names a phase the match has left — the same guard footballPosition
    // applies. RE-PIN the period-change event name against football.ts's
    // event schema before running (the 2026-09-05 plan used
    // `football.period` with `{ to, at }`).
    const f = folded("football", [
      ["core.start", {}],
      ["football.goal", { by: "home", at: { period: "H1", elapsed: 761 } }],
      ["football.period", { to: "HT", at: { period: "H1", elapsed: 2700 } }],
    ]);
    const out = projectOverlayLiveData({ row: ROW(3), folded: f, venueTz: "UTC" });
    expect(out.clock, "a stale clock on air is worse than no clock").toBeUndefined();
  });

  it("football: a stream nothing stamped carries no clock", () => {
    const f = folded("football", [["core.start", {}], ["football.goal", { by: "home" }]]);
    expect(projectOverlayLiveData({ row: ROW(2), folded: f, venueTz: "UTC" }).clock).toBeUndefined();
  });

  it("cricket: every innings' runs, wickets, legalBalls and ballsLimit, from the state — the quota derived from the cfg, never typed here", () => {
    const mod = moduleFor("cricket");
    const quota = (mod.configSchema.parse({}) as { ballsPerInnings: number }).ballsPerInnings;
    const ball = (over: number, b: number, runs: number) =>
      ["cricket.ball", { over, ballInOver: b, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p1", runs: { bat: runs } }] as const;
    const f = folded("cricket", [
      ["core.start", {}],
      ["cricket.toss", { winner: "home", decision: "bat" }],
      ball(0, 1, 4), ball(0, 2, 0), ball(0, 3, 1), ball(0, 4, 6), ball(0, 5, 0), ball(0, 6, 2),
      ["cricket.innings.close", { reason: "declared" }],
      ball(0, 1, 1),
    ]);
    const out = projectOverlayLiveData({ row: ROW(f.lastSeq), folded: f, venueTz: "UTC" });
    expect(out.cricket).toBeDefined();
    expect(out.cricket!.innings).toHaveLength(2);
    expect(out.cricket!.innings[0]).toMatchObject({ runs: 13, wickets: 0, legalBalls: 6, ballsLimit: quota });
    expect(out.cricket!.innings[1]).toMatchObject({ runs: 1, wickets: 0, legalBalls: 1, ballsLimit: quota });
    // The number the chase line renders — and it differs from the runs, so a
    // transposed pair cannot pass.
    expect(out.cricket!.innings[1]!.ballsLimit! - out.cricket!.innings[1]!.legalBalls).toBe(quota - 1);
    expect(out.clock).toBeUndefined();
  });

  it("cricket: a DLS revision moves ballsLimit with the target (the case that makes it a live number)", () => {
    // RE-PIN the revise payload shape against cricket.ts's schema (:991-1006)
    // — the 2026-09-05 plan used { target, ballsLimit, source: "dls" }.
    const f = folded("cricket", [
      ["core.start", {}],
      ["cricket.toss", { winner: "home", decision: "bat" }],
      ["cricket.innings.close", { reason: "declared" }],
      ["cricket.revise", { target: 91, ballsLimit: 60, source: "dls" }],
    ]);
    const out = projectOverlayLiveData({ row: ROW(f.lastSeq), folded: f, venueTz: "UTC" });
    expect(out.cricket!.innings[1]!.ballsLimit).toBe(60);
  });

  it("every other sport: neither clock nor cricket, by shape, not by a sport-key branch", () => {
    for (const key of ["tennis", "badminton", "volleyball", "tabletennis", "boardgame", "carrom", "generic"]) {
      const f = folded(key, [["core.start", {}]]);
      const out = projectOverlayLiveData({ row: ROW(1), folded: f, venueTz: "UTC" });
      expect(out.clock, key).toBeUndefined();
      expect(out.cricket, key).toBeUndefined();
    }
  });
});
```

  RE-PIN before writing: the event names and payload shapes (`core.start`, `football.goal` with `at`, `football.period`, `cricket.toss`, `cricket.ball`, `cricket.innings.close`, `cricket.revise`) against each module's zod event schemas — read three neighbouring cases in `football.time.test.ts` and `cricket.test.ts` and use THEIR shapes. A hand-invented event folds to `UNKNOWN_TYPE` and proves nothing. If `builtinModules[].outcome` is not a method, read the outcome off `summary` the way `foldFixture` does (`fold.ts:130-135`).

- [ ] **Step 6: Run it — expect red (collection).** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/server/overlay --reporter=json --outputFile=/tmp/ovl-w1/t0b-red.json; node -e "const r=require('/tmp/ovl-w1/t0b-red.json');console.log(r.numTotalTests,(r.testResults[0]||{}).message)"`
  Expected: `Cannot find module '../project'`, `numTotalTests: 0`.

- [ ] **Step 7: Write the projection.** Create `apps/web/src/server/overlay/project.ts`:

```ts
// The folded state → OverlayLiveData (design §3.2). Pure. The two fields the
// overlay needs beyond ScoreSummary are read off the module's own STATE —
// which foldFixture already holds — by SHAPE, so no sport-key branch exists
// here and a twelfth sport that carries `asOf` or `innings` is covered by
// construction (owner ruling 4: "all sports").
import type { FoldedFixture } from "@/server/engine-db/fold";
import type { LiveFixtureData, OverlayLiveData } from "@/components/public-site/live-score-data";

interface RowSnapshot {
  status: string;
  summary: LiveFixtureData["summary"];
  outcome: LiveFixtureData["outcome"];
  last_seq: number | null;
}

/** The period family's clock stamp, present only while it is CURRENT. The
 *  guard `asOf.period === phase` is footballPosition's own
 *  (football.ts:730-739): a stamp from a phase the match has left is no
 *  clock, not a wrong one. */
function clockOf(state: unknown, active: FoldedFixture["active"]): OverlayLiveData["clock"] {
  if (typeof state !== "object" || state === null) return undefined;
  const s = state as { phase?: unknown; asOf?: unknown };
  if (typeof s.phase !== "string") return undefined;
  if (typeof s.asOf !== "object" || s.asOf === null) return undefined;
  const asOf = s.asOf as { period?: unknown; elapsed?: unknown };
  if (asOf.period !== s.phase || typeof asOf.elapsed !== "number") return undefined;
  const last = active[active.length - 1];
  if (!last) return undefined;
  const wall = Date.parse(last.recordedAt);
  if (!Number.isFinite(wall)) return undefined;
  return { phase: s.phase, anchorSeconds: asOf.elapsed, anchorAtWallMs: wall };
}

/** Cricket's innings, by shape: an `innings[]` whose entries carry the four
 *  numbers. Anything else (no innings, or innings without `legalBalls`) is
 *  not cricket's state and yields nothing. */
function cricketOf(state: unknown): OverlayLiveData["cricket"] {
  if (typeof state !== "object" || state === null) return undefined;
  const raw = (state as { innings?: unknown }).innings;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const innings: NonNullable<OverlayLiveData["cricket"]>["innings"] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const e = entry as Record<string, unknown>;
    if (typeof e.runs !== "number" || typeof e.wickets !== "number" || typeof e.legalBalls !== "number") return undefined;
    if (!(e.ballsLimit === null || typeof e.ballsLimit === "number")) return undefined;
    innings.push({ runs: e.runs, wickets: e.wickets, legalBalls: e.legalBalls, ballsLimit: e.ballsLimit });
  }
  return { innings };
}

export function projectOverlayLiveData(input: {
  row: RowSnapshot;
  folded: FoldedFixture | null;
  venueTz: string;
}): OverlayLiveData {
  const { row, folded, venueTz } = input;
  const out: OverlayLiveData = {
    status: row.status,
    summary: row.summary,
    outcome: row.outcome,
    lastSeq: row.last_seq,
    venueTz,
  };
  if (!folded) return out;
  const clock = clockOf(folded.state, folded.active);
  if (clock) out.clock = clock;
  const cricket = cricketOf(folded.state);
  if (cricket) out.cricket = cricket;
  return out;
}
```

  and in `apps/web/src/components/public-site/live-score-data.ts`, after `LiveFixtureData`:

```ts
/** The overlay's one poll target (design §3.2). `status`/`summary`/`outcome`
 *  are the SAME row `LiveFixtureData` reads (one authority: match_states);
 *  `clock` and `cricket` are projected server-side off the folded state.
 *  W2 reads `lastSeq` as its mount-seq. */
export interface OverlayLiveData extends LiveFixtureData {
  lastSeq: number | null;
  venueTz: string;
  clock?: { phase: string; anchorSeconds: number; anchorAtWallMs: number };
  cricket?: { innings: { runs: number; wickets: number; legalBalls: number; ballsLimit: number | null }[] };
}

export async function fetchOverlayFixture(fixtureId: string): Promise<OverlayLiveData> {
  return api<OverlayLiveData>(`/api/v1/public/fixtures/${fixtureId}/overlay`);
}
```

- [ ] **Step 8: Run — expect PASS.** Re-run Step 6's command. Expected: `numTotalTests: 7`, `numFailedTests: 0`; every `.testResults[].name` under the worktree.

- [ ] **Step 9: Write the failing loader test — the fold runs ≤ 1× per `last_seq`.** Create `apps/web/src/server/overlay/__tests__/load.test.ts`:

```ts
// `loadOverlayLiveData` — cached public row + venue zone + a fold inside
// `unstable_cache` KEYED ON last_seq (design §3.2). The claim under test is
// the COST claim: with N polls at the same last_seq the ledger is folded
// once; a ledger advance folds once more. `unstable_cache` is a Next
// runtime API absent under vitest — this double is a real memo keyed on the
// keys array (the passthrough double the neighbouring tests use would let a
// missing key pass).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memo = new Map<string, unknown>();
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keys: string[]) => async () => {
    const k = keys.join("|");
    if (!memo.has(k)) memo.set(k, await fn());
    return memo.get(k);
  },
  revalidateTag: vi.fn(),
}));

const fold = vi.fn();
vi.mock("@/server/engine-db/fold", () => ({ foldFixture: (...args: unknown[]) => fold(...args) }));

const row = vi.fn();
vi.mock("@/server/usecases/public", () => ({ publicFixture: (...args: unknown[]) => row(...args) }));

vi.mock("@/lib/db", () => ({
  sql: Object.assign(
    async () => [{ division_tz: null, org_tz: "Europe/London" }],
    { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
  ),
}));

import { loadOverlayLiveData } from "../load";

beforeEach(() => {
  memo.clear();
  fold.mockReset();
  row.mockReset();
  fold.mockResolvedValue({ fixtureId: "fx", lastSeq: 3, state: {}, summary: {}, outcome: null, active: [] });
});
afterEach(() => vi.clearAllMocks());

const ROW = (last_seq: number) => ({ id: "fx", division_id: "d1", status: "in_play", summary: { headline: "1 — 0" }, outcome: null, last_seq });

describe("loadOverlayLiveData", () => {
  it("folds ONCE for three polls at the same last_seq", async () => {
    row.mockResolvedValue(ROW(3));
    await loadOverlayLiveData("fx");
    await loadOverlayLiveData("fx");
    const out = await loadOverlayLiveData("fx");
    expect(fold).toHaveBeenCalledTimes(1);
    expect(out.lastSeq).toBe(3);
    expect(out.venueTz).toBe("Europe/London");
    expect(out.summary).toEqual({ headline: "1 — 0" });
  });

  it("folds AGAIN when the ledger advances (the key is last_seq, not the fixture id)", async () => {
    row.mockResolvedValueOnce(ROW(3)).mockResolvedValueOnce(ROW(4));
    await loadOverlayLiveData("fx");
    await loadOverlayLiveData("fx");
    expect(fold).toHaveBeenCalledTimes(2);
  });

  it("a fixture with no events (last_seq null) skips the fold entirely", async () => {
    row.mockResolvedValue({ ...ROW(0), last_seq: null });
    const out = await loadOverlayLiveData("fx");
    expect(fold).not.toHaveBeenCalled();
    expect(out.clock).toBeUndefined();
    expect(out.cricket).toBeUndefined();
  });

  it("propagates publicFixture's 404 unchanged (visibility is the view's decision, not this loader's)", async () => {
    row.mockRejectedValue(Object.assign(new Error("fixture not found"), { status: 404 }));
    await expect(loadOverlayLiveData("fx")).rejects.toThrow("fixture not found");
    expect(fold).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 10: Run it — expect red (collection).** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/server/overlay/__tests__/load.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t0c-red.json; node -e "const r=require('/tmp/ovl-w1/t0c-red.json');console.log(r.numTotalTests,(r.testResults[0]||{}).message)"`
  Expected: `Cannot find module '../load'`.

- [ ] **Step 11: Write the loader.** Create `apps/web/src/server/overlay/load.ts`:

```ts
// The overlay endpoint's read (design §3.2). Three reads, one authority each:
// the public row from `publicFixture` (cached, the same view the match page
// reads — visibility decided THERE, never here); the venue zone through
// `resolveVenueTz` (the VENUE lane, lib/tz.ts:44); and the fold, inside
// `unstable_cache` keyed on `last_seq`, so N polls at one ledger position
// cost one fold. Fire-and-forget nothing; throw nothing new — a 404 from the
// row read is the 404 the route answers.
import "server-only";
import { unstable_cache } from "next/cache";
import { sql } from "@/lib/db";
import { resolveVenueTz } from "@/lib/tz";
import { foldFixture, type FoldedFixture } from "@/server/engine-db/fold";
import { publicFixture } from "@/server/usecases/public";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import { projectOverlayLiveData } from "./project";

interface PublicRow {
  id: string;
  division_id: string;
  status: string;
  summary: OverlayLiveData["summary"];
  outcome: OverlayLiveData["outcome"];
  last_seq: number | null;
}

/** Folds once per (fixture, last_seq). The fold reads the whole ledger and
 *  every module the fixture pins; at ~1 event / 36 s per T20 that is once
 *  per ledger advance, and never once per 15 s poll across every viewer. */
function cachedFold(fixtureId: string, lastSeq: number): () => Promise<FoldedFixture | null> {
  return unstable_cache(
    async () => sql.begin(async (tx) => foldFixture(tx, fixtureId)) as Promise<FoldedFixture | null>,
    ["overlay-fold", fixtureId, String(lastSeq)],
    { revalidate: 300 },
  );
}

export async function loadOverlayLiveData(fixtureId: string): Promise<OverlayLiveData> {
  const row = (await publicFixture(fixtureId)) as PublicRow;
  const [zone] = await sql<{ division_tz: string | null; org_tz: string | null }[]>`
    select ss.tz as division_tz, o.timezone as org_tz
    from divisions d
    left join schedule_settings ss on ss.division_id = d.id
    left join organizations o on o.id = d.org_id
    where d.id = ${row.division_id}`;
  const venueTz = resolveVenueTz(zone?.division_tz, zone?.org_tz);
  const folded = row.last_seq === null ? null : await cachedFold(fixtureId, row.last_seq)();
  return projectOverlayLiveData({ row, folded, venueTz });
}
```

  RE-PIN: `publicFixture`'s SELECT (`usecases/public.ts:296-303`) must include `division_id` — it does at `ac85c70` (`select id, division_id, …`). If `sql.begin` is typed to reject a non-array return, cast as shown; the precedent is `registration-submit.ts:609`.

- [ ] **Step 12: Run — expect PASS.** Re-run Step 10's command. Expected: `numTotalTests: 4`, `numFailedTests: 0`.

- [ ] **Step 13: Add the route, the OpenAPI row, regenerate.** Create `apps/web/src/app/api/v1/public/fixtures/[id]/overlay/route.ts`:

```ts
import { v1, reply } from "@/server/api-v1/http";
import { publicRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";
import { loadOverlayLiveData } from "@/server/overlay/load";

type Ctx = { params: Promise<{ id: string }> };

/** The stream overlay's one poll target (design §3.2): the public live
 *  summary plus the two folded-state facts a scorebug needs. Visibility is
 *  the public view's (404 ≡ missing); the ENTITLEMENT gate is on the overlay
 *  PAGE, not here — this JSON is public exactly as /public/fixtures/{id} is. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { id } = await params;
    const data = await loadOverlayLiveData(id);
    return reply(200, data, { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
```

  In `apps/web/src/server/api-v1/openapi.ts`, immediately after the `/public/fixtures/{id}/realtime-token` row (`:201`):

```ts
  { path: "/public/fixtures/{id}/overlay", method: "get", summary: "Stream overlay payload: the public live summary plus the folded-state clock (football family) and innings numbers (cricket)", tag: "public", public: true },
```

  Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npm run openapi:gen` and `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/server/api-v1/__tests__/openapi-coverage.test.ts src/server/api-v1/__tests__/key-scopes.test.ts src/server/api-v1/__tests__/openapi-published.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t0d.json` — expected `numFailedTests: 0` (the public route follows `/public/fixtures/{id}`'s classification; if `key-scopes.test.ts` names the new path, add the row it names beside that route's, and record it). Re-run `openapi:gen`: no further diff.

- [ ] **Step 14: Stage the e2e assertions Task 8 owns.** Add to Task 8's `stream-overlay.spec.ts` case list (Task 8 Step 1): `GET /api/v1/public/fixtures/{id}/overlay` answers 200 with `status`/`summary`/`outcome` DEEP-EQUAL to `GET /api/v1/public/fixtures/{id}`'s, `lastSeq` a number, `venueTz` a valid IANA string; after ONE `football.goal` with an `at` stamp on a football fixture, `clock.phase === "H1"` and `clock.anchorSeconds` equals the stamp; on the cricket fixture, `cricket.innings[0].ballsLimit` equals the T20 quota; a fixture whose org lacks `streaming.overlay` STILL answers 200 here (the gate is the page's), and a private competition's fixture answers 404. Written there, run there.

- [ ] **Step 15: Mutation checks — five, each named.**
  1. `data.ts`: delete the venue-zone query and hardcode `venueTz: "UTC"`. Re-run Step 4's command. Expected red: `falls back to the organisation's zone…` — `expected 'UTC' to be 'Asia/Kolkata'`. Restore.
  2. `load.ts`: change the cache keys to `["overlay-fold", fixtureId]` (drop `last_seq`). Re-run Step 12's command. Expected red: `folds AGAIN when the ledger advances` — `expected "spy" to be called 2 times, but got 1`. Restore.
  3. `project.ts` `clockOf`: delete `asOf.period !== s.phase ||`. Re-run Step 8's command. Expected red: `between periods the clock is ABSENT` — `expected { phase: 'HT', … } to be undefined`. Restore.
  4. `project.ts` `cricketOf`: swap `runs` and `wickets` in the pushed object. Expected red: `cricket: every innings' runs…` — `toMatchObject` names `runs`. Restore.
  5. `project.ts`: `anchorAtWallMs: Date.now()` instead of the last envelope's wall time. Expected red: `football: a stamped goal…` — `expected <now> to equal 1788...` . Restore.
  A surviving mutant is a missing test, not a note. Record all five with their killers in the PR inventory.

- [ ] **Step 16: Gate `apps/web` against the baseline.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<ovl url> DATABASE_SSL=disable npx vitest run --reporter=json --outputFile=/tmp/ovl-w1/t0-web-full.json; node -e "const r=require('/tmp/ovl-w1/t0-web-full.json');console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)"`
  Expected: the T1 Task 0 baseline in `_STATE.md` plus this task's 4 + 7 + 4 new tests, no new red. `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npx tsc --noEmit -p apps/web/tsconfig.json; echo "EXIT=$?"` → `EXIT=0` (the local build skips typechecking; a green build proves nothing about types). `packages/engine` is UNTOUCHED — `/usr/bin/git status --porcelain packages` prints nothing.

- [ ] **Step 17: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/server/public-site/data.ts apps/web/src/server/public-site/__tests__/public-fixture-venue-tz.test.ts apps/web/src/components/public-site/live-score-data.ts apps/web/src/server/overlay/project.ts apps/web/src/server/overlay/load.ts apps/web/src/server/overlay/__tests__/project.test.ts apps/web/src/server/overlay/__tests__/load.test.ts "apps/web/src/app/api/v1/public/fixtures/[id]/overlay/route.ts" apps/web/src/server/api-v1/openapi.ts apps/web/openapi/v1.json apps/web/openapi/v1.public.json`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(data): venue zone on the public payload, and the overlay endpoint over foldFixture" -m "Owner answers 12 and 19 (2026-09-06), design §3.2 (2026-09-07). The venue zone rides on getPublicFixture via resolveVenueTz. The football clock anchor and cricket's innings numbers are projected off the folded STATE the engine already holds, inside unstable_cache keyed on last_seq — one fold per ledger advance, zero engine edits, no golden re-baseline." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01LJGBoVPAWczYB9c45TD1aw"`


---

### Task 1: Extract the live transport into `useLiveFixture` and repoint `LiveScore`

**Files:**
- Create: `apps/web/src/components/public-site/use-live-fixture.ts`
- Create (Test): `apps/web/src/components/public-site/__tests__/use-live-fixture.test.tsx`
- Modify: `apps/web/src/components/public-site/live-score.tsx` — imports `:8-27`, `POLL_MS` `:29`, body `:59-117`, `subscribed` read `:148`
- Unchanged regression witness: `apps/web/src/components/public-site/__tests__/live-score.test.tsx`, `apps/web/src/components/public-site/__tests__/live-score-data.test.ts`

**Interfaces:**
- Consumes: `fetchLiveFixture(fixtureId: string): Promise<LiveFixtureData>`, `fetchPublicRealtimeToken(fixtureId: string): Promise<PublicRealtimeToken>`, `type LiveFixtureData` — all from `./live-score-data`; `supabaseBrowser()` from `@/lib/supabase-browser` (dynamic import).
- Produces:
  - `export const POLL_MS: number` (15_000)
  - `export const DEBOUNCE_MS: number` (250)
  - `export function isLiveStatus(status: string): boolean`
  - `export interface LiveFixture<T extends LiveFixtureData = LiveFixtureData> { data: T; live: boolean; subscribed: boolean; refresh: () => Promise<void>; presentationNowOffsetMs: number }` (amended 2026-09-07: generic, plus the offset)
  - `export interface LiveFixtureOptions<T extends LiveFixtureData> { fetcher?: (fixtureId: string) => Promise<T>; delayMs?: number }`
  - `export function useLiveFixture<T extends LiveFixtureData = LiveFixtureData>(fixtureId: string, initial: T, realtime: boolean, options?: LiveFixtureOptions<T>): LiveFixture<T>` — `LiveScore` calls it with three arguments and is byte-identical in behaviour; the overlay stage passes `{ fetcher: fetchOverlayFixture }`; R2 passes `delayMs`.

> **Conflict with the wave prompt, recorded:** scope 1 writes the return type as bare `LiveFixtureData`. `LiveScore` renders `subscribed` at `live-score.tsx:148` (`Live{subscribed ? " · realtime" : ""}`), and the same scope requires its render to stay untouched — a bare `LiveFixtureData` return cannot satisfy both. The object return above is the minimum that does. `live` is returned because the overlay stage needs it for the live-dot breath (`_THEMES.md` §6).

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/components/public-site/__tests__/use-live-fixture.test.tsx`:

```tsx
// The public live transport, lifted out of LiveScore (W1 scope 1). vitest runs
// `environment: "node"` here (vitest.config.ts:129), so the hook is driven
// through `renderIsland` — React's dispatcher without a DOM — and the poll is
// witnessed by CAPTURING setInterval rather than faking a clock, the same
// idiom live-score.test.tsx:37-40 already uses.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import {
  isLiveStatus,
  POLL_MS,
  useLiveFixture,
  type LiveFixture,
} from "../use-live-fixture";
import type { LiveFixtureData } from "../live-score-data";

function stubFetch(payload: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status, json: async () => payload })),
  );
}

/** Captures setInterval's callback and the delay it was armed with. */
function stubInterval(): { fire: () => Promise<void>; delay: () => number | null; armed: () => number } {
  let callback: (() => void | Promise<void>) | null = null;
  let delay: number | null = null;
  let armed = 0;
  vi.stubGlobal(
    "setInterval",
    ((fn: () => void, ms?: number) => {
      callback = fn;
      delay = ms ?? null;
      armed += 1;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
  );
  vi.stubGlobal("clearInterval", (() => {}) as typeof clearInterval);
  return {
    fire: async () => {
      if (!callback) throw new Error("setInterval was never armed — the hook did not start polling");
      await callback();
    },
    delay: () => delay,
    armed: () => armed,
  };
}

const IN_PLAY: LiveFixtureData = { status: "in_play", summary: { headline: "1 — 0" }, outcome: null };
const DECIDED: LiveFixtureData = {
  status: "decided",
  summary: { headline: "2 — 0" },
  outcome: { kind: "win", winner: "e-home" },
};

/** Probe island: the harness renders COMPONENTS, so the hook is called inside
 *  one and its return captured for assertions. */
function harness(initial: LiveFixtureData, realtime: boolean) {
  let latest: LiveFixture | null = null;
  const island = renderIsland(
    (props: { fixtureId: string; initial: LiveFixtureData; realtime: boolean }) => {
      latest = useLiveFixture(props.fixtureId, props.initial, props.realtime);
      return null;
    },
    { fixtureId: "fx-1", initial, realtime },
  );
  return { island, read: (): LiveFixture => latest as unknown as LiveFixture };
}

afterEach(() => vi.unstubAllGlobals());

describe("isLiveStatus", () => {
  it("is true for the two statuses that can still move, false for the rest", () => {
    expect(isLiveStatus("in_play")).toBe(true);
    expect(isLiveStatus("scheduled")).toBe(true);
    expect(isLiveStatus("decided")).toBe(false);
    expect(isLiveStatus("finalized")).toBe(false);
    expect(isLiveStatus("cancelled")).toBe(false);
  });
});

describe("useLiveFixture", () => {
  it("arms exactly one poll at POLL_MS while in play with realtime off, and a tick replaces the data", async () => {
    const timer = stubInterval();
    stubFetch({ ok: true, data: { status: "in_play", summary: { headline: "2 — 0" }, outcome: null } });
    const { read } = harness(IN_PLAY, false);
    expect(timer.armed(), "one interval, not one per render").toBe(1);
    expect(timer.delay()).toBe(POLL_MS);
    expect(read().data.summary?.headline).toBe("1 — 0");
    await timer.fire();
    expect(read().data.summary?.headline, "the poll's payload replaced the score").toBe("2 — 0");
    expect(read().live).toBe(true);
  });

  it("never arms a poll for a fixture that is already decided at mount", () => {
    const timer = stubInterval();
    stubFetch({ ok: true, data: DECIDED });
    const { read } = harness(DECIDED, false);
    expect(timer.armed(), "a decided fixture must not poll").toBe(0);
    expect(read().live).toBe(false);
    expect(read().subscribed).toBe(false);
  });

  it("falls back to the poll when the realtime token is refused (403)", () => {
    const timer = stubInterval();
    stubFetch({ ok: false, error: "payment required" }, false, 403);
    const { read } = harness(IN_PLAY, true);
    expect(timer.armed(), "a refused token leaves subscribed false, so the poll must run").toBe(1);
    expect(read().subscribed).toBe(false);
  });

  it("keeps the last known score when a poll throws", async () => {
    const timer = stubInterval();
    stubFetch({ ok: false, error: "boom" }, false, 500);
    const { read } = harness(IN_PLAY, false);
    await timer.fire();
    expect(read().data.summary?.headline, "a transient failure must not blank the scoreboard").toBe("1 — 0");
  });

  it("stops polling once the fixture it is polling becomes decided", async () => {
    const timer = stubInterval();
    stubFetch({ ok: true, data: DECIDED });
    const { read } = harness(IN_PLAY, false);
    expect(timer.armed()).toBe(1);
    await timer.fire();
    expect(read().data.status).toBe("decided");
    expect(read().live, "live follows the DATA, not the initial prop").toBe(false);
    expect(timer.armed(), "the effect re-ran with live false and armed nothing new").toBe(1);
  });
});
```

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/components/public-site/__tests__/use-live-fixture.test.tsx --reporter=json --outputFile=/tmp/ovl-w1/t1-red.json`
  Expected: the suite fails to COLLECT with `Failed to resolve import "../use-live-fixture" from "src/components/public-site/__tests__/use-live-fixture.test.tsx"`. In the JSON that is `numTotalTests: 0` with a non-empty `testResults[0].message` — a collection failure, which `rtk` would have printed as `PASS(0) FAIL(0)`. Read the JSON.

- [ ] **Step 2a (amended 2026-09-07, design §3.3): the fetcher and delay cases.** Append INSIDE the same `describe` in `use-live-fixture.test.tsx`, after Step 1's last case. Step 1's `stubInterval` captures ONE callback; the delay buffer arms a SECOND interval (1000 ms) beside the poll (`POLL_MS`), so these cases use a stub keyed by delay:

```tsx
/** Every setInterval, keyed by its delay — the poll (POLL_MS) and the delay
 *  drain (1000) are told apart by the number they were armed with. */
function stubIntervals(): { fire: (ms: number) => Promise<void>; armed: () => number[] } {
  const byDelay = new Map<number, () => void | Promise<void>>();
  vi.stubGlobal(
    "setInterval",
    ((fn: () => void, ms?: number) => {
      byDelay.set(ms ?? -1, fn);
      return byDelay.size as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
  );
  vi.stubGlobal("clearInterval", (() => {}) as typeof clearInterval);
  return {
    fire: async (ms) => {
      const cb = byDelay.get(ms);
      if (!cb) throw new Error(`no interval armed at ${ms} ms — armed: ${[...byDelay.keys()].join(",")}`);
      await cb();
    },
    armed: () => [...byDelay.keys()].sort((a, b) => a - b),
  };
}

function harnessWith<T extends LiveFixtureData>(initial: T, realtime: boolean, options: LiveFixtureOptions<T>) {
  let latest: LiveFixture<T> | null = null;
  const island = renderIsland(
    (props: { fixtureId: string; initial: T; realtime: boolean }) => {
      latest = useLiveFixture<T>(props.fixtureId, props.initial, props.realtime, options);
      return null;
    },
    { fixtureId: "fx-1", initial, realtime },
  );
  return { island, read: (): LiveFixture<T> => latest as unknown as LiveFixture<T> };
}

it("uses the fetcher it is given, and fetchLiveFixture's URL by default (one transport, two payloads)", async () => {
  const timers = stubIntervals();
  stubFetch({ ...IN_PLAY, summary: { headline: "9 — 9" } });
  const own = vi.fn(async (id: string) => ({ ...IN_PLAY, summary: { headline: `own:${id}` } }));
  const h = harnessWith(IN_PLAY, false, { fetcher: own });
  await timers.fire(POLL_MS);
  expect(own).toHaveBeenCalledWith("fx-1");
  expect(h.read().data.summary?.headline).toBe("own:fx-1");
  // Default: the public endpoint, through global fetch.
  const d = harnessWith(IN_PLAY, false, {});
  await timers.fire(POLL_MS);
  expect((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => String(c[0]).endsWith("/api/v1/public/fixtures/fx-1"))).toBe(true);
  expect(d.read().data.summary?.headline).toBe("9 — 9");
});

it("without options arms ONLY the poll — no drain interval, offset 0 (byte-identical to LiveScore's behaviour)", () => {
  const timers = stubIntervals();
  const h = harnessWith(IN_PLAY, false, {});
  expect(timers.armed()).toEqual([POLL_MS]);
  expect(h.read().presentationNowOffsetMs).toBe(0);
});

it("delayMs: a refreshed snapshot is presented only once delayMs has elapsed, on the drain tick, and the offset is exposed", async () => {
  const timers = stubIntervals();
  const now = vi.spyOn(Date, "now");
  now.mockReturnValue(100_000);
  const fetcher = vi.fn(async () => ({ ...IN_PLAY, summary: { headline: "1 — 1" } }));
  const h = harnessWith(IN_PLAY, false, { fetcher, delayMs: 3000 });
  expect(h.read().presentationNowOffsetMs).toBe(3000);
  expect(timers.armed()).toEqual([1000, POLL_MS]);
  await timers.fire(POLL_MS);                 // received at 100 000
  expect(h.read().data.summary?.headline, "not yet — 3 s have not passed").toBe(IN_PLAY.summary?.headline);
  now.mockReturnValue(102_000);
  await timers.fire(1000);
  expect(h.read().data.summary?.headline, "2 s in: still held").toBe(IN_PLAY.summary?.headline);
  now.mockReturnValue(103_000);
  await timers.fire(1000);
  expect(h.read().data.summary?.headline, "3 s in: presented").toBe("1 — 1");
  now.mockRestore();
});

it("delayMs: two snapshots received 500 ms apart present in order, newest-due wins, nothing is skipped backwards", async () => {
  const timers = stubIntervals();
  const now = vi.spyOn(Date, "now");
  let n = 0;
  const fetcher = vi.fn(async () => ({ ...IN_PLAY, summary: { headline: `s${++n}` } }));
  const h = harnessWith(IN_PLAY, false, { fetcher, delayMs: 2000 });
  now.mockReturnValue(10_000);
  await timers.fire(POLL_MS);                 // s1 @ 10 000
  now.mockReturnValue(10_500);
  await timers.fire(POLL_MS);                 // s2 @ 10 500
  now.mockReturnValue(12_200);
  await timers.fire(1000);                    // s1 due (12 000), s2 not (12 500)
  expect(h.read().data.summary?.headline).toBe("s1");
  now.mockReturnValue(12_600);
  await timers.fire(1000);
  expect(h.read().data.summary?.headline).toBe("s2");
  now.mockRestore();
});
```

  Add `type LiveFixtureOptions` to the file's imports from `../use-live-fixture`. RE-PIN: `renderIsland`'s exact signature and whether effects run synchronously on first render (`components/__tests__/_hook-harness.tsx:169`) — if effects are deferred, call the harness's flush before reading `timers.armed()`. Re-run Step 2's command: the four new cases red for `useLiveFixture is not a function` / missing export until Step 3 lands.


- [ ] **Step 3: Implement the hook.** Create `apps/web/src/components/public-site/use-live-fixture.ts`:

```ts
"use client";
// THE public live transport (W1 scope 1, R5). Lifted verbatim out of
// `live-score.tsx` so the public match page and the stream overlay share ONE
// subscribe-or-poll implementation instead of two copies that drift: Pro orgs
// get a Supabase Realtime push on the private channel `fixture:{id}`
// (`lib/realtime.ts:9,27,91`, event `state_changed`, payload carries no body),
// everyone else falls back to a 15 s poll of the public fixture endpoint.
// Behaviour — the interval, the 250 ms debounce, the "any failure leaves
// `subscribed` false" rule — is contract, not tuning (R5).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchLiveFixture,
  fetchPublicRealtimeToken,
  type LiveFixtureData,
} from "./live-score-data";

export const POLL_MS = 15_000;
/** The realtime ping carries no body, so several pings in a burst would fire
 *  several refetches; one debounced refetch answers all of them. */
export const DEBOUNCE_MS = 250;

/** The two statuses that can still change under the reader. Exported so a
 *  consumer (and the unit suite) reads the same predicate the effects do —
 *  a second `status === "in_play" || …` written elsewhere is the drift this
 *  extraction exists to prevent. */
export function isLiveStatus(status: string): boolean {
  return status === "in_play" || status === "scheduled";
}

export interface LiveFixture<T extends LiveFixtureData = LiveFixtureData> {
  data: T;
  /** How far behind wall time the PRESENTED snapshot is (= `delayMs`, 0 by
   *  default). The overlay clock subtracts it; nothing else reads it. */
  presentationNowOffsetMs: number;
  /** `isLiveStatus(data.status)` — recomputed from the LIVE data, never from
   *  the initial prop, so a fixture that decides while the page is open stops
   *  polling on the very next tick. */
  live: boolean;
  /** Realtime actually connected. `LiveScore` renders it as "· realtime"; the
   *  overlay ignores it (OBS shows no transport state). */
  subscribed: boolean;
  refresh: () => Promise<void>;
}

/** Amended 2026-09-07 (design §3.3): generic over the payload and its
 *  fetcher, so `LiveScore` (public JSON) and the overlay stage (the overlay
 *  endpoint) share ONE transport with two payloads. `delayMs` is R2's
 *  presentation buffer, built here so the seam is real from W1: with it
 *  absent the hook is byte-identical in behaviour. */
export interface LiveFixtureOptions<T extends LiveFixtureData> {
  fetcher?: (fixtureId: string) => Promise<T>;
  /** Present snapshots no sooner than `delayMs` after they were received. */
  delayMs?: number;
}

export function useLiveFixture<T extends LiveFixtureData = LiveFixtureData>(
  fixtureId: string,
  initial: T,
  realtime: boolean,
  options: LiveFixtureOptions<T> = {},
): LiveFixture<T> {
  const fetcher = (options.fetcher ?? (fetchLiveFixture as unknown as (id: string) => Promise<T>));
  const delayMs = options.delayMs ?? 0;
  // The newest snapshot RECEIVED (always current) and the one PRESENTED
  // (held back by delayMs). With delayMs 0 they are the same state.
  const [data, setData] = useState<T>(initial);
  const bufferRef = useRef<{ receivedAt: number; snapshot: T }[]>([]);

  const present = useCallback(
    (snapshot: T) => {
      if (delayMs <= 0) {
        setData(snapshot);
        return;
      }
      bufferRef.current.push({ receivedAt: Date.now(), snapshot });
    },
    [delayMs],
  );

  // Drain the delay buffer once per second: present the newest snapshot whose
  // receivedAt ≤ now − delayMs. One interval, only while delayMs > 0.
  useEffect(() => {
    if (delayMs <= 0) return;
    const id = setInterval(() => {
      const due = Date.now() - delayMs;
      const buf = bufferRef.current;
      let idx = -1;
      for (let i = 0; i < buf.length; i++) if (buf[i]!.receivedAt <= due) idx = i;
      if (idx >= 0) {
        setData(buf[idx]!.snapshot);
        bufferRef.current = buf.slice(idx + 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [delayMs]);

  const refresh = useCallback(async () => {
    try {
      present(await fetcher(fixtureId));
    } catch {
      // transient — keep the last known score
    }
  }, [fixtureId, fetcher, present]);

  const live = isLiveStatus(data.status);

  // Realtime push (Pro orgs). Any failure — no entitlement (403), env missing,
  // websocket refused — leaves `subscribed` false and polling takes over.
  const [subscribed, setSubscribed] = useState(false);
  useEffect(() => {
    if (!realtime || !live) return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channel: any = null;

    (async () => {
      let token: { token: string; channel: string };
      try {
        token = await fetchPublicRealtimeToken(fixtureId);
      } catch {
        return; // not entitled or server error → polling
      }
      if (cancelled) return;
      const { supabaseBrowser } = await import("@/lib/supabase-browser");
      const sb = supabaseBrowser();
      await sb.realtime.setAuth(token.token);
      channel = sb
        .channel(token.channel, { config: { private: true } })
        .on("broadcast", { event: "state_changed" }, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(refresh, DEBOUNCE_MS);
        })
        .subscribe((status: string) => {
          if (!cancelled) setSubscribed(status === "SUBSCRIBED");
        });
    })();

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      channel?.unsubscribe();
      setSubscribed(false);
    };
  }, [fixtureId, realtime, live, refresh]);

  // 15 s polling fallback (Community, or realtime not connected).
  useEffect(() => {
    if (!live || subscribed) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [live, subscribed, refresh]);

  // The ONE authority for "how far behind the wall clock is the picture":
  // the football clock (use-overlay-clock.ts) subtracts it so a delayed goal
  // and the clock advance land together (design §3.6).
  return { data, live, subscribed, refresh, presentationNowOffsetMs: delayMs };
}
```

- [ ] **Step 4: Repoint `LiveScore`.** In `apps/web/src/components/public-site/live-score.tsx`, replace the import block `:8-27` and the state/effect body `:59-117` so the file reads (unchanged parts elided — Props `:32-50` and everything from `const inPlay` at `:118` down are untouched):

```tsx
"use client";
// Live scoreboard for the public match page (doc 09 §2). The subscribe-or-poll
// transport moved to `./use-live-fixture` (stream overlay W1, R5) so this page
// and the OBS overlay share one implementation; this component's Props, its
// derivations and its entire render are unchanged by that move.
import {
  disciplineLabel,
  disciplineList,
  matchStrength,
  periodBreakdown,
  servingSide,
  setBreakdown,
  stripLiveSetPoints,
} from "@/lib/public-site";
import { type LiveFixtureData } from "./live-score-data";
import { useLiveFixture } from "./use-live-fixture";
import {
  renderDecidedOutcome,
  shootoutScoreFromDetail,
  type DecidedOutcomeTemplates,
} from "@/lib/scoring-vocab";

export type { LiveFixtureData };
```

and the body opener:

```tsx
export function LiveScore({
  fixtureId,
  initial,
  realtime,
  entrantNames,
  sportKey,
  decidedTemplates,
}: Props) {
  const { data, subscribed } = useLiveFixture(fixtureId, initial, realtime);

  const inPlay = data.status === "in_play";
```

  Deletions: the `useCallback, useEffect, useState` import from `react`, the `fetchLiveFixture` / `fetchPublicRealtimeToken` imports, `const POLL_MS = 15_000;` (`:29`), and the whole `:59-117` block (`useState`, `refresh`, `live`, both effects).

- [ ] **Step 5: Run — expect PASS, including the untouched regression witnesses.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/components/public-site --reporter=json --outputFile=/tmp/ovl-w1/t1-green.json`
  Expected: `numFailedTests: 0`; `use-live-fixture.test.tsx` contributes 10 tests (Step 1's six plus Step 2a's four); `live-score.test.tsx` and `live-score-data.test.ts` pass with ZERO edits. Confirm every `.testResults[].name` starts with `/Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web/src/components/public-site/`.

- [ ] **Step 6: Mutation check (d) — delete the poll guard.** Temporarily change `if (!live || subscribed) return;` to `if (subscribed) return;` in `use-live-fixture.ts`, re-run Step 5's command. Expected red: `never arms a poll for a fixture that is already decided at mount` — `expected 1 to be 0`. Restore the guard and re-run to green. Record "mutant (d) killed by use-live-fixture.test.tsx › never arms a poll…" in the PR inventory.

- [ ] **Step 7: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/components/public-site/use-live-fixture.ts apps/web/src/components/public-site/__tests__/use-live-fixture.test.tsx apps/web/src/components/public-site/live-score.tsx`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(transport): lift LiveScore's subscribe-or-poll into useLiveFixture" -m "One transport for the public match page and the OBS overlay (R5). LiveScore's Props and render are untouched; live-score.test.tsx is the unedited regression witness." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 2: The pure projection — `overlayModel`

**Files:**
- Modify: `apps/web/src/lib/public-site.ts` — append after `disciplineLabel` (`:378`)
- Create (Test): `apps/web/src/lib/__tests__/public-site-overlay-derive.test.ts`
- Create: `apps/web/src/lib/overlay-model.ts`
- Create (Test): `apps/web/src/lib/__tests__/overlay-model.test.ts`

**Interfaces:**
- Consumes: `setBreakdown(summary: unknown, sportKey: string): SetBreakdown | null` (`public-site.ts:290`), `periodBreakdown(summary: unknown): PeriodScoreRow[] | null` (`:319`), `matchStrength(summary: unknown): string | null` (`:338`), `disciplineList(summary: unknown): DisciplineEntry[] | null` (`:352`), `servingSide(summary: unknown): "home" | "away" | null` (`:373`), `disciplineLabel(classKey: string): string` (`:377`); `renderDecidedOutcome(outcome, entrantNames: Record<string,string>, templates: DecidedOutcomeTemplates, shootoutScore?): string | null` (`scoring-vocab.ts:1345`), `shootoutScoreFromDetail(detail: unknown)` (`:1410`), `type DecidedOutcomeTemplates` (`:1296`); `type LiveFixtureData` (`live-score-data.ts:7`).
- Also consumes, from **Task 0** (amended 2026-09-07): `OverlayLiveData.cricket.innings[]` (`{ runs, wickets, legalBalls, ballsLimit }`, off the folded state) and `getPublicFixture(...).venueTz`. The football clock is NOT a model input read off the payload: `OverlayLiveData.clock` anchors the STAGE's 1 Hz timer (Task 5, `use-overlay-clock.ts`), which hands the model a formatted `clockLabel`.
- Produces (in `public-site.ts`):
  - `export function battingEntrantId(summary: unknown): string | null`
  - `export function chaseNeed(summary: unknown): number | null`
  - `export function chaseBalls(cricket: OverlayLiveData["cricket"] | null | undefined): number | null` (amended 2026-09-07 — reads the endpoint's innings, not `summary.detail`)
- Produces (in `overlay-model.ts`, amended 2026-09-07):
  - `export function formatClock(seconds: number): string` — `mm:ss`, minutes unbounded ("90:00", "104:12"); RE-PIN: if `@seazn/engine/core` exports `formatElapsed`, delegate to it and delete the local body (one authority)
- Produces (in `overlay-model.ts`):
  - `export type OverlayMsg = (key: string, vars?: Record<string, string | number>) => string`
  - `export interface OverlaySideInput { id: string; name: string; short?: string | null }`
  - `export interface OverlaySide { short: string; name: string; big: string; sub?: string; led: boolean; serving: boolean }`
  - `export interface OverlayCell { key: string; value: string }`
  - `export interface OverlayModel { live: boolean; decided: boolean; header: { context: string; clock?: string }; sides: [OverlaySide, OverlaySide]; cells: OverlayCell[]; detail: string[]; chase?: string; result?: string }`
  - `export interface OverlayMoment { kind: string; headline: string; line?: string; tone: "led" | "caution" | "dismissal" }` — **type only**, W2's slot (R4). W2 re-declares it in `lib/overlay-moments.ts` with an added `seq: number`; keep the four fields identically named so the widening is additive.
  - `export interface OverlayModelInput { sportKey: string; data: OverlayLiveData; sides: [OverlaySideInput, OverlaySideInput]; startLabel: string | null; clockLabel: string | null; msg: OverlayMsg; decidedTemplates: DecidedOutcomeTemplates }` (amended 2026-09-07: `data` is the endpoint's payload; `clockLabel` is the stage's formatted tick, `null` when there is nothing to show)
  - `export function shortCode(side: OverlaySideInput): string`
  - `export function splitLine(line: string): { big: string; sub?: string }`
  - `export function overlayStartLabel(iso: string | null, locale: string, tz: string): string | null`
  - `export function overlayModel(input: OverlayModelInput): OverlayModel`

> **Three deviations from the wave prompt's scope 2, each recorded as a finding:**
> 1. `msg` is typed `OverlayMsg` (a plain `string` key), not `MsgFn` (`scoring-vocab.ts:1147`). `MsgFn`'s key type is `MessageKey = keyof typeof messages` (`lib/messages.ts:12`), and `messages` is `dictionaries/en/ui.json` — the overlay's copy is the `public` namespace, so every `overlay.*` key would fail to type-check against `MsgFn`. `OverlayMsg` is structurally a supertype, so a real `MsgFn` is still assignable.
> 2. `overlayModel` also takes `decidedTemplates`. The decided sentence's one authority is `renderDecidedOutcome` (`scoring-vocab.ts:1345`), whose templates are built from **ui** keys (`fixture.decidedBy.*`) — exactly what `LiveScore` already receives as a prop. Re-implementing that sentence off `summary.headline` would be a second authority for a fact this repo already owns.
> 3. `startLabel: string | null` stays a formatted string on the input rather than the model computing it: `overlayModel` takes no zone and no `Intl`, so it stays pure and locale-free. What CHANGED with owner answer 12 is where the string comes from — `overlayStartLabel(iso, locale, venueTz)` in this same file, called by the overlay page with the `venueTz` Task 0 puts on the payload. One formatter, tested here, instead of an `Intl.DateTimeFormat` literal inlined in `page.tsx`.
>
> **Owner answer 12 (2026-09-06) closed the two W1 deviations and the unpinned clock that used to sit here.** Deviation 4 ("start time formats in UTC") and deviation 6 ("chase reads 'Need 45', not 'Need 45 off 45'") are both closed by Task 0, and so is "football's clock is unpinned". Their replacements: the start label formats in `venueTz`, the chase line renders `overlay.chase.needBalls`, and `header.clock` is the STAGE's ticking value handed in as `clockLabel` (amended 2026-09-07: the anchor rides the overlay endpoint, `useOverlayClock` advances it — Task 5 Step 8a — and this pure model only places the string). Nothing in this task may fall back to UTC, to a runs-only chase line, or read a clock off the summary.
>
> **One open pin recorded here rather than guessed:**
> - `short` has no source. `public_entrants_v` (`db/migration/deltas/V350__person_tombstone_views.sql:18-47`) exposes `display_name` and a `team_display` jsonb of `club_id/club_name/logo_path/colors` — **no `short_name`**; `teams.short_name` exists (`V206:5`) but does not reach the public payload. Watch-list 6 therefore resolves to **the three-letter fallback**, and the panel copy says so (`ui.stream.codeNote`, Task 6).

- [ ] **Step 1: Write the failing test for the four new summary readers.** Create `apps/web/src/lib/__tests__/public-site-overlay-derive.test.ts`:

```ts
// The four ScoreSummary readers the stream overlay needs and nothing else owned
// (W1 scope 2). They live beside `servingSide`/`setBreakdown` in
// `lib/public-site.ts` for the reason R5 states: one home for every "read the
// public summary without an engine import" derivation.
//
// Driven off the REAL cricket summary shape (`packages/engine/src/sports/
// cricket/cricket.ts:3285-3325`: `detail.innings[] = { entrantId, runs,
// wickets, legalBalls, declared, closed }`) for `battingEntrantId` and
// `chaseNeed`, and off the overlay ENDPOINT's `cricket.innings[]` (Task 0,
// design §3.2: `{ runs, wickets, legalBalls, ballsLimit }`, projected from the
// folded state) for `chaseBalls` — amended 2026-09-07. No summary field is
// invented here; the clock is not a reader at all (it is the stage's timer).
import { describe, expect, it } from "vitest";
import { battingEntrantId, chaseBalls, chaseNeed } from "@/lib/public-site";
import { formatClock } from "@/lib/overlay-model";

const innings = (entrantId: string, runs: number, closed: boolean) => ({
  entrantId, runs, wickets: 2, legalBalls: 60, ballsLimit: 120, declared: false, closed,
});

describe("battingEntrantId", () => {
  it("names the entrant of the last innings that has not closed", () => {
    const summary = { detail: { innings: [innings("e-home", 180, true), innings("e-away", 91, false)] } };
    expect(battingEntrantId(summary)).toBe("e-away");
  });

  it("is null once every innings has closed", () => {
    const summary = { detail: { innings: [innings("e-home", 180, true), innings("e-away", 181, true)] } };
    expect(battingEntrantId(summary)).toBeNull();
  });

  it("is null for a sport whose detail carries no innings at all", () => {
    expect(battingEntrantId({ detail: { sets: [{ home: 21, away: 15, closed: true }] } })).toBeNull();
    expect(battingEntrantId({ detail: null })).toBeNull();
    expect(battingEntrantId(null)).toBeNull();
  });
});

describe("chaseNeed", () => {
  it("is the first innings' total plus one, less what the chasing side has", () => {
    const summary = { detail: { innings: [innings("e-home", 180, true), innings("e-away", 91, false)] } };
    expect(chaseNeed(summary)).toBe(90);
  });

  it("prefers an explicit revised target when the detail carries one (DLS)", () => {
    const summary = {
      detail: { target: 160, targetSource: "dls", innings: [innings("e-home", 180, true), innings("e-away", 91, false)] },
    };
    expect(chaseNeed(summary), "the revised target replaces the first innings' total, it does not add to it").toBe(69);
  });

  it("is null in the first innings, and null once the chase is complete", () => {
    expect(chaseNeed({ detail: { innings: [innings("e-home", 91, false)] } })).toBeNull();
    expect(chaseNeed({ detail: { innings: [innings("e-home", 180, true), innings("e-away", 181, true)] } })).toBeNull();
  });

  it("is null for a sport with no innings", () => {
    expect(chaseNeed({ detail: { periods: [{ phase: "H1", home: 1, away: 0 }] } })).toBeNull();
  });
});

describe("chaseBalls (amended 2026-09-07: reads OverlayLiveData.cricket, the endpoint's innings off the folded state)", () => {
  // The denominator `_THEMES.md` §3 draws: "Need 45 off 45". Task 0's endpoint
  // carries `ballsLimit` beside `legalBalls`; this is the only place that
  // subtracts. Whether a chase is IN PROGRESS is `chaseNeed`'s call (summary);
  // the model asks this only when `chaseNeed` is non-null.
  const inn = (runs: number, legalBalls: number, ballsLimit: number | null) => ({ runs, wickets: 2, legalBalls, ballsLimit });

  it("is the chasing innings' quota less the legal balls it has faced", () => {
    expect(chaseBalls({ innings: [inn(180, 120, 120), inn(91, 60, 120)] }), "120 quota less 60 bowled").toBe(60);
  });

  it("follows a DLS-revised quota rather than the format's original", () => {
    expect(chaseBalls({ innings: [inn(180, 120, 120), inn(91, 60, 90)] })).toBe(30);
  });

  it("is null where the format declares no quota, null in the first innings, and null with no cricket at all", () => {
    // A timed/unlimited format carries `ballsLimit: null` (cricket.ts:440) —
    // "off null balls" must never render, so the line falls back to runs only.
    expect(chaseBalls({ innings: [inn(180, 120, 120), inn(91, 60, null)] })).toBeNull();
    expect(chaseBalls({ innings: [inn(91, 60, 120)] })).toBeNull();
    expect(chaseBalls(undefined)).toBeNull();
    expect(chaseBalls(null)).toBeNull();
  });

  it("never goes negative when the quota has been overshot", () => {
    expect(chaseBalls({ innings: [inn(180, 120, 120), inn(91, 130, 120)] })).toBe(0);
  });
});

describe("formatClock (overlay-model.ts)", () => {
  it("formats mm:ss with minutes unbounded, zero-padded seconds", () => {
    expect(formatClock(761)).toBe("12:41");
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(5400)).toBe("90:00");
    expect(formatClock(6252)).toBe("104:12");
  });
  it("floors fractional seconds and clamps negatives to zero", () => {
    expect(formatClock(59.9)).toBe("00:59");
    expect(formatClock(-3)).toBe("00:00");
  });
});
```

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/public-site-overlay-derive.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t2a-red.json`
  Expected: collection failure — `"battingEntrantId" is not exported by "src/lib/public-site.ts"`. `numTotalTests: 0`.

- [ ] **Step 3: Implement the readers.** Append to `apps/web/src/lib/public-site.ts` immediately after `disciplineLabel` (`:377-380`):

```ts
/**
 * The entrant currently batting: the last innings on the public summary that
 * has not closed. Cricket's `summary().detail.innings[]` is the only shape in
 * the engine with this field set (`sports/cricket/cricket.ts:3306-3316`), so
 * every other sport returns null by construction rather than by a sport check.
 *
 * This is the FIRST authority for "who is in" on the public payload — nothing
 * else derives it — and it lives here, beside `servingSide`, so the overlay
 * and any later spectator surface read one implementation (R5).
 */
export function battingEntrantId(summary: unknown): string | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { innings?: unknown }).innings;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const last = raw[raw.length - 1];
  if (typeof last !== "object" || last === null) return null;
  const { entrantId, closed } = last as Record<string, unknown>;
  if (closed === true) return null;
  return typeof entrantId === "string" ? entrantId : null;
}

/**
 * Runs still needed by the side batting second, or null when there is no chase
 * in progress. A revised target (DLS, `detail.target`) REPLACES the first
 * innings' total; without one the target is that total plus one.
 *
 * The BALLS half of "Need 45 off 45" is `chaseBalls` below, kept separate so a
 * format with no quota still gets its runs line.
 */
export function chaseNeed(summary: unknown): number | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { innings?: unknown }).innings;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const first = raw[raw.length - 2];
  const current = raw[raw.length - 1];
  if (typeof first !== "object" || first === null) return null;
  if (typeof current !== "object" || current === null) return null;
  if ((current as Record<string, unknown>).closed === true) return null;
  const chased = (current as Record<string, unknown>).runs;
  if (typeof chased !== "number") return null;
  const revised = (detail as { target?: unknown }).target;
  if (typeof revised === "number") return Math.max(0, revised - chased);
  const set = (first as Record<string, unknown>).runs;
  if (typeof set !== "number") return null;
  return Math.max(0, set + 1 - chased);
}

/**
 * Balls still available to the side batting second, or null.
 *
 * The denominator of the line `_THEMES.md` §3 draws — "Need 45 off 45". Both
 * numbers come from the SAME innings entry the overlay endpoint projects off
 * the folded state (Task 0, design §3.2: `OverlayLiveData.cricket.innings[]`),
 * so a DLS revision moves them together and nothing here re-derives a quota
 * from a format name. Whether a chase is in progress is `chaseNeed`'s
 * decision over the summary; the model calls this only when it is.
 *
 * `null`, never a guess, where the format declares no quota (`ballsLimit:
 * null` — timed and unlimited formats, cricket.ts:440): the bar then renders
 * the runs-only line, which is correct rather than short.
 */
export function chaseBalls(
  cricket: { innings: { legalBalls: number; ballsLimit: number | null }[] } | null | undefined,
): number | null {
  if (!cricket || !Array.isArray(cricket.innings) || cricket.innings.length < 2) return null;
  const current = cricket.innings[cricket.innings.length - 1]!;
  if (typeof current.ballsLimit !== "number" || typeof current.legalBalls !== "number") return null;
  return Math.max(0, current.ballsLimit - current.legalBalls);
}
```

  and in `apps/web/src/lib/overlay-model.ts` (Step 7 creates the file; this export goes beside `overlayStartLabel`):

```ts
/**
 * `mm:ss` for the football family's clock cell. Minutes are unbounded
 * ("90:00", "104:12" in extra time) because a period clock never wraps to
 * hours on air. The STAGE owns the number (use-overlay-clock.ts, the one 1 Hz
 * timer); this only spells it. RE-PIN: if `@seazn/engine/core` exports
 * `formatElapsed`, this becomes `return formatElapsed(seconds)` and the body
 * below is deleted — one authority for the format.
 */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/public-site-overlay-derive.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t2a-green.json`
  Expected: `numTotalTests: 13`, `numFailedTests: 0`.

- [ ] **Step 5: Write the failing projection test.** Create `apps/web/src/lib/__tests__/overlay-model.test.ts`:

```ts
// `overlayModel` — the ONE projection all eleven sports render through (R3).
//
// Every case folds a SHORT REAL ledger through the REAL module
// (`foldMatch`, packages/engine/src/core/events.ts:445, with
// `defaultLineupPair`/`makeEnvelope` from `@seazn/engine/testkit`) and projects
// the module's OWN `summary()` — the pattern
// `components/v2/scorepad/__tests__/view-model.test.ts:8-12` uses. A typed
// summary table on both ends would only prove the table.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { V3_SKINS } from "@/components/v2/scorepad/v3/registry";
import { overlayModel, overlayStartLabel, shortCode, splitLine, type OverlayMsg } from "@/lib/overlay-model";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { LiveFixtureData, OverlayLiveData } from "@/components/public-site/live-score-data";

/** A msg that returns its own key, so any literal that leaked into the model
 *  shows up as prose among keys (R14). Never the real dictionary. */
const keyMsg: OverlayMsg = (key, vars) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

const TEMPLATES: DecidedOutcomeTemplates = {
  tie: "TIE",
  plain: "WIN {winner}",
  shootoutPlain: "WIN {winner} SO",
  byMethod: { regulation: "WIN {winner} REG" },
};

const SIDES: [{ id: string; name: string }, { id: string; name: string }] = [
  { id: "H", name: "Milton Keynes Rovers" },
  { id: "A", name: "Northbridge Athletic" },
];

const moduleFor = (key: string) => {
  const m = builtinModules.find((mod) => mod.key === key);
  if (!m) throw new Error(`no builtin module for "${key}" — the skin list and the module list disagree`);
  return m;
};

/** Folds `stream` through the real module and returns the LiveFixtureData the
 *  public endpoint would serve for it. */
function payload(
  key: string,
  stream: readonly (readonly [string, unknown])[],
  status: string,
  outcome: LiveFixtureData["outcome"] = null,
): LiveFixtureData {
  const mod = moduleFor(key);
  const cfg = mod.configSchema.parse({});
  const lineups = defaultLineupPair(mod.positions);
  const events: EventEnvelope[] = stream.map(([type, p], i) =>
    makeEnvelope(i, { type, payload: p } as never),
  );
  const state = foldMatch(mod as never, cfg as never, lineups, events);
  const summary = (mod as { summary: (s: unknown) => LiveFixtureData["summary"] }).summary(state);
  return { status, summary, outcome };
}

/** `payload()` returns the public shape; the model takes the OVERLAY shape
 *  (a superset — Task 0). The two extra fields default here so the eleven
 *  sport cases stay short; the clock and cricket cases pass them explicitly. */
const project = (key: string, data: LiveFixtureData | OverlayLiveData, startLabel: string | null = null, clockLabel: string | null = null) =>
  overlayModel({
    sportKey: key,
    data: { lastSeq: null, venueTz: "UTC", ...data } as OverlayLiveData,
    sides: SIDES,
    startLabel,
    clockLabel,
    msg: keyMsg,
    decidedTemplates: TEMPLATES,
  });

const CRICKET_BALL = (over: number, ball: number, runs: number) =>
  ["cricket.ball", { over, ballInOver: ball, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p1", runs: { bat: runs } }] as const;

describe("shortCode / splitLine", () => {
  it("upper-cases the first three letters when the entrant has no short name", () => {
    expect(shortCode({ id: "H", name: "Milton Keynes Rovers" })).toBe("MIL");
    expect(shortCode({ id: "A", name: "ab" })).toBe("AB");
    expect(shortCode({ id: "A", name: "  " })).toBe("—");
  });

  it("prefers an explicit short name, upper-cased", () => {
    expect(shortCode({ id: "H", name: "Milton Keynes Rovers", short: "mkr" })).toBe("MKR");
  });

  it("splits a kernel side line into its value and its trailing meta", () => {
    expect(splitLine("142/6 (20)")).toEqual({ big: "142/6", sub: "(20)" });
    expect(splitLine("3")).toEqual({ big: "3" });
  });
});

describe("overlayModel — the empty case first", () => {
  it("a scheduled fixture is not live, shows an em dash both sides and no cells", () => {
    const model = project("generic", { status: "scheduled", summary: null, outcome: null }, "Sat 14:00");
    expect(model.live).toBe(false);
    expect(model.decided).toBe(false);
    expect(model.sides[0].big).toBe("—");
    expect(model.sides[1].big).toBe("—");
    expect(model.sides[0].led).toBe(false);
    expect(model.sides[1].led).toBe(false);
    expect(model.cells).toEqual([]);
    expect(model.detail).toEqual([]);
    expect(model.result).toBeUndefined();
    expect(model.chase).toBeUndefined();
    expect(model.header.context, "the server-formatted start time, in the venue zone").toBe("Sat 14:00");
  });

  it("falls back to a dictionary key when a scheduled fixture has no start time", () => {
    const model = project("generic", { status: "scheduled", summary: null, outcome: null }, null);
    expect(model.header.context).toBe("overlay.header.notStarted");
  });
});

describe("overlayModel — every skin key projects without throwing", () => {
  it("covers all eleven V3_SKINS keys, each with an empty payload", () => {
    const keys = Object.keys(V3_SKINS).sort();
    expect(keys.length, "R3: eleven skins is the working sport-key list").toBe(11);
    for (const key of keys) {
      const model = project(key, { status: "scheduled", summary: null, outcome: null });
      expect(model.sides.length, key).toBe(2);
      expect(model.sides[0].short, key).toBe("MIL");
      expect(model.cells, key).toEqual([]);
    }
  });
});

describe("overlayModel — led and serving truth table", () => {
  it("cricket: the LED sits on the side batting, and moves when the innings does", () => {
    const first = payload("cricket", [
      ["cricket.toss", { winner: "home", decision: "bat" }],
      ["core.start", {}],
      CRICKET_BALL(0, 1, 4),
    ], "in_play");
    const a = project("cricket", first);
    expect(a.sides[0].led, "home is batting").toBe(true);
    expect(a.sides[1].led).toBe(false);
    expect(a.sides[0].serving, "cricket has no serve").toBe(false);

    const second = payload("cricket", [
      ["cricket.toss", { winner: "home", decision: "bat" }],
      ["core.start", {}],
      CRICKET_BALL(0, 1, 4),
      ["cricket.innings.close", { reason: "declared" }],
    ], "in_play");
    const b = project("cricket", second);
    expect(
      [b.sides[0].led, b.sides[1].led],
      "an ordering-differential case: the LED must FLIP with the innings, not sit on home by construction",
    ).not.toEqual([a.sides[0].led, a.sides[1].led]);
  });

  it("tennis: the LED and the serve dot follow the server", () => {
    const data = payload("tennis", [
      ["core.start", {}],
      ["tennis.point", { by: "away" }],
    ], "in_play");
    const model = project("tennis", data);
    const serving = model.sides.findIndex((s) => s.serving);
    expect(serving, "the kernel declares a server at rally fidelity").toBeGreaterThanOrEqual(0);
    expect(model.sides[serving].led, "the server carries the LED").toBe(true);
    expect(model.sides[1 - serving].led).toBe(false);
  });

  it("football: neither side is led or serving while the match is level and open", () => {
    const data = payload("football", [["core.start", {}]], "in_play");
    const model = project("football", data);
    expect(model.sides.map((s) => s.led)).toEqual([false, false]);
    expect(model.sides.map((s) => s.serving)).toEqual([false, false]);
  });

  it("boardgame, carrom and generic have no cells and no detail, by construction", () => {
    for (const key of ["boardgame", "carrom", "generic"]) {
      const data = payload(key, [["core.start", {}]], "in_play");
      const model = project(key, data);
      expect(model.cells, key).toEqual([]);
      expect(model.detail, key).toEqual([]);
    }
  });
});

describe("overlayModel — cells", () => {
  it("badminton renders one cell per game, in order, home–away", () => {
    const data = payload("badminton", [
      ["core.start", {}],
      ...Array.from({ length: 21 }, () => ["badminton.rally", { wonBy: "home" }] as const),
    ], "in_play");
    const model = project("badminton", data);
    expect(model.cells.length, "one closed game").toBeGreaterThanOrEqual(1);
    expect(model.cells[0].key).toBe("1");
    expect(model.cells[0].value).toMatch(/^\d+–\d+$/);
  });

  it("football renders one cell per period once periods exist", () => {
    const data = payload("football", [
      ["core.start", {}],
      ["football.goal", { by: "home" }],
      ["core.period.end", {}],
    ], "in_play");
    const model = project("football", data);
    for (const cell of model.cells) expect(cell.value).toMatch(/^\d+–\d+$/);
  });
});

describe("overlayModel — decided", () => {
  it("sets result from the decided templates, drops chase, and leaves the LED on the winner", () => {
    const data = payload("football", [
      ["core.start", {}],
      ["football.goal", { by: "home" }],
    ], "decided", { kind: "win", winner: "H", method: "regulation" });
    const model = project("football", data);
    expect(model.decided).toBe(true);
    expect(model.live).toBe(false);
    expect(model.result, "the ONE decided-sentence authority, renderDecidedOutcome").toBe(
      "WIN Milton Keynes Rovers REG",
    );
    expect(model.chase).toBeUndefined();
    expect(model.sides[0].led, "the winner keeps the LED").toBe(true);
    expect(model.sides[1].led).toBe(false);
  });
});

describe("overlayModel — cricket chase line", () => {
  it("renders 'Need 45 off 45' through msg, never as a typed literal", () => {
    const data: LiveFixtureData = {
      status: "in_play",
      summary: {
        headline: "180/8 (20) — 91/3 (12)",
        perSide: [{ entrantId: "H", line: "180/8 (20)" }, { entrantId: "A", line: "91/3 (12)" }],
        detail: {
          innings: [
            { entrantId: "H", runs: 180, wickets: 8, legalBalls: 120, ballsLimit: 120, declared: false, closed: true },
            { entrantId: "A", runs: 91, wickets: 3, legalBalls: 72, ballsLimit: 120, declared: false, closed: false },
          ],
        },
      },
      outcome: null,
    };
    const model = project("cricket", data);
    // Owner answer 12 closed deviation 6: both numbers, the shape `_THEMES.md`
    // §3 draws. The runs and the balls DIFFER here (90 vs 48) on purpose — with
    // equal numbers a transposed pair would pass.
    expect(model.chase).toBe("overlay.chase.needBalls(runs=90,balls=48)");
    expect(model.sides[1].big).toBe("91/3");
    expect(model.sides[1].sub).toBe("(12)");
    expect(model.detail, "W2 fills cricket's detail band; W1 leaves it empty (spec §2)").toEqual([]);
  });

  it("falls back to the runs-only line where the format declares no quota", () => {
    // Timed / unlimited cricket carries `ballsLimit: null` — "off null balls"
    // must never reach air, so the shorter key is the CORRECT render here, not
    // a degraded one.
    const data: LiveFixtureData = {
      status: "in_play",
      summary: {
        headline: "180/8 — 91/3",
        perSide: [{ entrantId: "H", line: "180/8" }, { entrantId: "A", line: "91/3" }],
        detail: {
          innings: [
            { entrantId: "H", runs: 180, wickets: 8, legalBalls: 300, ballsLimit: null, declared: true, closed: true },
            { entrantId: "A", runs: 91, wickets: 3, legalBalls: 130, ballsLimit: null, declared: false, closed: false },
          ],
        },
      },
      outcome: null,
    };
    expect(project("cricket", data).chase).toBe("overlay.chase.need(runs=90)");
  });
});

describe("overlayModel — the football family's clock", () => {
  it("places the stage's formatted clock in header.clock, and drops it on a decided frame (amended 2026-09-07)", () => {
    // The clock is the STAGE's 1 Hz timer, formatted by `formatClock` before it
    // reaches this pure model — the model neither reads a stamp nor derives a
    // number. The bar and the bug both render the cell only when it is set,
    // so an empty slot is invisible and a wrong one is on air for ninety
    // minutes; a decided frame shows none.
    const data: OverlayLiveData = {
      status: "in_play",
      summary: {
        headline: "2 — 1",
        perSide: [{ entrantId: "H", line: "2" }, { entrantId: "A", line: "1" }],
        detail: { periods: [{ phase: "H1", home: 1, away: 1 }, { phase: "H2", home: 1, away: 0 }] },
      },
      outcome: null,
      lastSeq: 9,
      venueTz: "UTC",
      clock: { phase: "H2", anchorSeconds: 761, anchorAtWallMs: 0 },
    };
    const model = project("football", data, null, "12:41");
    expect(model.header.clock).toBe("12:41");
    expect(model.header.context, "the phase is the context; the clock is its own cell").toBe("H2");
    const done = project("football", { ...data, status: "decided", outcome: { kind: "win", winner: "H" } }, null, "90:00");
    expect(done.header.clock, "no clock on a decided frame, whatever the stage hands in").toBeUndefined();
  });

  it("leaves the clock absent when the stage has nothing to show, and for a sport with none", () => {
    const unstamped: OverlayLiveData = {
      status: "in_play",
      summary: {
        headline: "0 — 0",
        perSide: [{ entrantId: "H", line: "0" }, { entrantId: "A", line: "0" }],
        detail: { periods: [{ phase: "H1", home: 0, away: 0 }] },
      },
      outcome: null,
      lastSeq: 1,
      venueTz: "UTC",
    };
    expect(project("football", unstamped, null, null).header.clock).toBeUndefined();
    const badminton = payload("badminton", [["core.start", {}], ["badminton.rally", { wonBy: "home" }]], "in_play");
    expect(project("badminton", badminton).header.clock).toBeUndefined();
  });
});

describe("overlayStartLabel", () => {
  // The formatter the overlay page calls with the `venueTz` Task 0 puts on the
  // payload. It lives here, beside the model, so the model itself stays pure
  // and free of `Intl` (deviation 3) while the format has ONE home and a test.
  const KICKOFF = "2026-09-05T14:30:00.000Z";

  it("formats in the VENUE zone — a UTC fallback would fail this case", () => {
    const label = overlayStartLabel(KICKOFF, "en-GB", "Asia/Kolkata");
    // 14:30 UTC is 20:00 in Kolkata. Asserted against the zone-shifted value
    // computed the same way, so the case moves if the format does but still
    // cannot pass on a UTC fallback.
    expect(label).toContain("20:00");
    expect(label, "this is the whole point of owner answer 12").not.toContain("14:30");
    expect(overlayStartLabel(KICKOFF, "en-GB", "UTC")).toContain("14:30");
  });

  it("honours the locale as well as the zone", () => {
    const nl = overlayStartLabel(KICKOFF, "nl", "Europe/Amsterdam");
    const en = overlayStartLabel(KICKOFF, "en-GB", "Europe/Amsterdam");
    expect(nl).toContain("16:30");
    expect(nl, "the weekday is localised, so the two labels differ").not.toBe(en);
  });

  it("is null with no scheduled time, and degrades rather than throwing on a bad zone", () => {
    expect(overlayStartLabel(null, "en-GB", "Europe/Amsterdam")).toBeNull();
    // `resolveVenueTz` should never hand this on, but a RangeError from
    // `Intl.DateTimeFormat` here would 500 the overlay mid-broadcast.
    expect(overlayStartLabel(KICKOFF, "en-GB", "Mars/Olympus_Mons")).toContain("14:30");
  });
});

describe("overlayModel — no literal escapes the dictionary", () => {
  it("every string the model produces is a msg key, a kernel value or a name", () => {
    const data = payload("volleyball", [
      ["core.start", {}],
      ["volleyball.rally", { wonBy: "home" }],
    ], "in_play");
    const model = project("volleyball", data);
    for (const line of model.detail) {
      expect(line, "detail lines are dictionary keys or engine notation, never English typed here")
        .toMatch(/^(overlay\.|[0-9]|[A-Za-z]{1,3}v[0-9])/);
    }
  });
});
```

- [ ] **Step 6: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/overlay-model.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t2b-red.json`
  Expected: collection failure — `Failed to resolve import "@/lib/overlay-model"`. `numTotalTests: 0`.

- [ ] **Step 7: Implement the projection.** Create `apps/web/src/lib/overlay-model.ts`:

```ts
// The stream overlay's ONE projection (spec §2, R3). Pure: no React, no
// `@/server/**` (the stage that calls it is a client component — a client
// component importing @/server is a BUILD failure), no engine import. Every
// derivation is imported from `@/lib/public-site`, never re-derived (R5).
//
// All eleven sports render through this. Board game, carrom and generic come
// out with `cells: []` and `detail: []` — a designed state, not an error.
import {
  battingEntrantId,
  chaseBalls,
  chaseNeed,
  disciplineLabel,
  disciplineList,
  matchStrength,
  periodBreakdown,
  servingSide,
  setBreakdown,
} from "@/lib/public-site";
import {
  renderDecidedOutcome,
  shootoutScoreFromDetail,
  type DecidedOutcomeTemplates,
} from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

/**
 * A dictionary lookup over the `public` namespace. Deliberately NOT
 * `scoring-vocab.ts`'s `MsgFn`, whose key type is `keyof typeof ui.json`
 * (`lib/messages.ts:12`) and would reject every `overlay.*` key. A real
 * `MsgFn` is assignable to this.
 */
export type OverlayMsg = (key: string, vars?: Record<string, string | number>) => string;

export interface OverlaySideInput {
  id: string;
  name: string;
  /** The entrant's own short name where one ever reaches the public payload.
   *  None does today — `public_entrants_v` carries `display_name` and a
   *  `team_display` blob with no `short_name` — so this is always absent and
   *  `shortCode` falls to three letters. */
  short?: string | null;
}

export interface OverlaySide {
  short: string;
  name: string;
  big: string;
  sub?: string;
  /** The side in play: batting, or serving, or the winner once decided. */
  led: boolean;
  serving: boolean;
}

export interface OverlayCell {
  key: string;
  value: string;
}

export interface OverlayModel {
  live: boolean;
  decided: boolean;
  header: { context: string; clock?: string };
  sides: [OverlaySide, OverlaySide];
  cells: OverlayCell[];
  detail: string[];
  chase?: string;
  result?: string;
}

/**
 * W2's slot (R4). A TYPE ONLY in W1 — nothing constructs one, the stage
 * renders an empty `ovl-moment-slot`, and W2 re-declares the same four fields
 * plus `seq` in `lib/overlay-moments.ts`. Named here so W1's components can
 * leave room for it without importing a module that does not exist yet.
 */
export interface OverlayMoment {
  kind: string;
  headline: string;
  line?: string;
  tone: "led" | "caution" | "dismissal";
}

export interface OverlayModelInput {
  sportKey: string;
  /** The overlay endpoint's payload (Task 0, design §3.2) — the public
   *  summary plus `cricket.innings[]` for the chase denominator. */
  data: OverlayLiveData;
  sides: [OverlaySideInput, OverlaySideInput];
  /** The kick-off, already formatted by the server in the venue zone and the
   *  reader's locale. Null when the fixture carries no time. */
  startLabel: string | null;
  /** The football family's clock, already ticking and formatted by the STAGE
   *  (`useOverlayClock` → `formatClock`). Null when there is nothing to show.
   *  The model never reads a stamp and never derives a number. */
  clockLabel: string | null;
  msg: OverlayMsg;
  /** The decided sentence's templates — `fixture.decidedBy.*`, the `ui`
   *  namespace — resolved server-side exactly as `LiveScore` receives them. */
  decidedTemplates: DecidedOutcomeTemplates;
}

const EM_DASH = "—";

/** Three letters, upper-cased — the bug's code column. Punctuation and spaces
 *  are dropped first so "St. Ives" reads STI, not "ST.". */
export function shortCode(side: OverlaySideInput): string {
  const explicit = side.short?.trim();
  if (explicit) return explicit.toUpperCase();
  const letters = side.name.replace(/[^\p{L}\p{N}]/gu, "");
  return letters.length > 0 ? letters.slice(0, 3).toUpperCase() : EM_DASH;
}

/** Kernel side lines are "<value> <meta>" — "142/6 (20)", "3". The value is
 *  the big numeral; anything after the first space is the meta column. */
export function splitLine(line: string): { big: string; sub?: string } {
  const at = line.indexOf(" ");
  if (at < 0) return { big: line };
  const sub = line.slice(at + 1).trim();
  return sub ? { big: line.slice(0, at), sub } : { big: line.slice(0, at) };
}

function headerContext(input: OverlayModelInput, decided: boolean): string {
  const { data, msg, sportKey, startLabel } = input;
  if (decided) return msg("overlay.header.ended");
  if (data.status === "scheduled") return startLabel ?? msg("overlay.header.notStarted");
  const periods = periodBreakdown(data.summary);
  if (periods && periods.length > 0) return periods[periods.length - 1]!.phase;
  const breakdown = setBreakdown(data.summary, sportKey);
  if (breakdown) {
    const n = breakdown.sets.length;
    return breakdown.unit === "Game" ? msg("overlay.header.game", { n }) : msg("overlay.header.set", { n });
  }
  return msg("overlay.header.live");
}

function cellsOf(input: OverlayModelInput): OverlayCell[] {
  const breakdown = setBreakdown(input.data.summary, input.sportKey);
  if (breakdown) {
    return breakdown.sets.map((s, i) => ({ key: String(i + 1), value: `${s.home}–${s.away}` }));
  }
  const periods = periodBreakdown(input.data.summary);
  if (periods) return periods.map((p) => ({ key: p.phase, value: `${p.home}–${p.away}` }));
  return [];
}

/**
 * The bar's second band in W1: the serve line, the strength chip and the
 * discipline list — every one of them already on the aggregate summary.
 *
 * NO PERSON NAME is rendered here. `disciplineList` entries carry an optional
 * `person`, but a name on air needs the consent resolver (R17) and that is
 * W2's work; the class and the side are what W1 shows. Cricket's band is
 * empty in W1 by spec §2 — and comes out empty here anyway, since cricket
 * declares neither serve, strength nor discipline.
 */
function detailOf(input: OverlayModelInput, codes: [string, string], live: boolean): string[] {
  const lines: string[] = [];
  const serving = servingSide(input.data.summary);
  if (live && serving) {
    lines.push(input.msg("overlay.detail.serving", { side: serving === "home" ? codes[0] : codes[1] }));
  }
  const strength = live ? matchStrength(input.data.summary) : null;
  if (strength) lines.push(strength);
  for (const entry of disciplineList(input.data.summary) ?? []) {
    lines.push(
      input.msg("overlay.detail.card", {
        side: entry.side === "home" ? codes[0] : codes[1],
        card: disciplineLabel(entry.classKey),
      }),
    );
  }
  return lines;
}

/** Which entrant carries the LED bar: the winner once decided, else the side
 *  batting, else the side serving, else nobody. */
function ledEntrantId(input: OverlayModelInput, decided: boolean): string | null {
  if (decided) return input.data.outcome?.winner ?? null;
  const batting = battingEntrantId(input.data.summary);
  if (batting) return batting;
  const serving = servingSide(input.data.summary);
  if (serving) return serving === "home" ? input.sides[0].id : input.sides[1].id;
  return null;
}

export function overlayModel(input: OverlayModelInput): OverlayModel {
  const { data, msg, sides } = input;
  const decided = data.status === "decided" || data.status === "finalized";
  const live = data.status === "in_play";
  const codes: [string, string] = [shortCode(sides[0]), shortCode(sides[1])];
  const led = ledEntrantId(input, decided);
  const serving = servingSide(data.summary);
  // Kernel perSide order is [home, away]; a payload with anything else is a
  // payload this projection cannot place, so it falls to the em-dash state
  // rather than guessing which line belongs to which row.
  const perSide = data.summary?.perSide;
  const usable = Array.isArray(perSide) && perSide.length === 2 ? perSide : null;

  const overlaySides = ([0, 1] as const).map((row): OverlaySide => {
    const input_ = sides[row];
    const line = usable ? splitLine(usable[row]!.line) : { big: EM_DASH };
    return {
      short: codes[row],
      name: input_.name,
      big: line.big,
      ...(line.sub === undefined ? {} : { sub: line.sub }),
      led: led !== null && led === input_.id,
      serving: serving !== null && (row === 0 ? "home" : "away") === serving,
    };
  }) as [OverlaySide, OverlaySide];

  const need = decided ? null : chaseNeed(data.summary);
  // Owner answer 12: both halves of `_THEMES.md` §3's line when the format
  // declares a quota, the runs-only key when it does not. Two keys rather than
  // one with an empty `{balls}` — a dangling "off" is worse than a short line.
  const balls = need === null ? null : chaseBalls(data.cricket);
  // The clock is the STAGE's timer (use-overlay-clock.ts), formatted before it
  // reaches this pure model; decided frames show none (amended 2026-09-07).
  const clock = decided ? null : input.clockLabel;
  const result = renderDecidedOutcome(
    data.outcome,
    { [sides[0].id]: sides[0].name, [sides[1].id]: sides[1].name },
    input.decidedTemplates,
    shootoutScoreFromDetail(data.summary?.detail),
  );

  return {
    live,
    decided,
    header: {
      context: headerContext(input, decided),
      ...(clock === null ? {} : { clock }),
    },
    sides: overlaySides,
    cells: cellsOf(input),
    detail: input.sportKey === "cricket" ? [] : detailOf(input, codes, live),
    ...(need === null
      ? {}
      : {
          chase:
            balls === null
              ? msg("overlay.chase.need", { runs: need })
              : msg("overlay.chase.needBalls", { runs: need, balls }),
        }),
    ...(result === null ? {} : { result }),
  };
}

/**
 * The start time a pre-match overlay prints, in the VENUE's zone.
 *
 * Owner answer 12 (2026-09-06) closed deviation 4: this used to be an
 * `Intl.DateTimeFormat` literal inlined in the overlay page with
 * `timeZone: "UTC"`, which is simply the wrong time for an Indian or Dutch club
 * audience. `tz` comes from `getPublicFixture(...).venueTz` — the VENUE lane
 * (`resolveVenueTz`, "one zone per fixture"), never the viewer's cookie and
 * never the organiser's personal zone: a London club can run an event in
 * Malaga, and the stream is watched in neither.
 *
 * Lives here rather than in the page so the format has one home and a test;
 * `overlayModel` itself still takes the finished string and stays pure
 * (deviation 3). An unusable zone degrades to UTC rather than throwing — a
 * `RangeError` here would 500 the overlay mid-broadcast.
 */
export function overlayStartLabel(iso: string | null, locale: string, tz: string): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: tz }).format(when);
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(when);
  }
}
```

- [ ] **Step 8: Run — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/overlay-model.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t2b-green.json`
  Expected: `numFailedTests: 0`, `numTotalTests: 19` (13 as first planned, plus the six owner answer 12 added: one runs-only chase fallback, two clock cases, three `overlayStartLabel` cases). If a sport's event name in `CRICKET_BALL` / `["tennis.point", …]` / `["volleyball.rally", …]` is rejected by the fold (`WRONG_PHASE`, `UNKNOWN_TYPE`), fix the STREAM against the module's `eventSchemas`, never the assertion — a stream the engine refuses is a test that proves nothing.

- [ ] **Step 9: Mutation check (b) — swap `led` to the other side.** Change the return in `ledEntrantId` from `input.sides[0].id : input.sides[1].id` to `input.sides[1].id : input.sides[0].id`, re-run Step 8. Expected red: `tennis: the LED and the serve dot follow the server` — `expected false to be true`. Restore.

- [ ] **Step 10: Mutation check (c) — return `[]` from the cells branch.** Change `cellsOf`'s first branch to `if (breakdown) return [];`, re-run Step 8. Expected red: `badminton renders one cell per game, in order, home–away` — `expected +0 to be greater than or equal to 1`. Restore and re-run to green.

- [ ] **Step 11: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/lib/overlay-model.ts apps/web/src/lib/public-site.ts apps/web/src/lib/__tests__/overlay-model.test.ts apps/web/src/lib/__tests__/public-site-overlay-derive.test.ts`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(model): one pure projection for all eleven sports" -m "overlayModel projects the public ScoreSummary into the bar/bug shape; battingEntrantId and chaseNeed join the other public-site summary readers. Every case is folded through the real module (R3, R5)." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 3: The stream link — validation, column, view, write path, OpenAPI

**Files:**
- Create: `apps/web/src/lib/stream-url.ts`
- Create (Test): `apps/web/src/lib/__tests__/stream-url.test.ts`
- Create: `db/migration/deltas/V400__fixture_stream_url.sql`
- Modify: `apps/web/src/server/public-site/data.ts` — `PublicFixture` (`:206`), the `getPublicFixture` SELECT (`:711-716`)
- Modify: `apps/web/src/server/usecases/public.ts` — `publicFixture()`'s `Pick<>` and SELECT (`:263-297`)
- Modify: `apps/web/src/server/api-v1/schemas.ts` — after `PatchedFixture`'s neighbourhood, next to `PatchFixture` (`:964-989`)
- Modify: `apps/web/src/server/usecases/fixtures.ts` — after `patchFixture` (`:136-176`)
- Create: `apps/web/src/app/api/v1/fixtures/[id]/stream/route.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts` (after `:142`), `apps/web/src/server/api-v1/key-scopes.ts` (after `:175`)
- Create (Test): `apps/web/src/server/usecases/__tests__/fixture-stream-url.test.ts`
- Generated: `apps/web/openapi/v1.json`, `apps/web/openapi/v1.public.json`

**Interfaces:**
- Consumes: `requireResourceAuth(req: Request, kind: "fixture", id: string, scope: "write"): Promise<AuthCtx>` (`server/api-v1/auth.ts:352`); `v1`, `parseBody` from `@/server/api-v1/http`; `withTenant(orgId, fn)` and `sql` from `@/lib/db`; `HttpError` from `@/lib/errors`; `fireDivisionRevalidate(divisionId: string, competitionId?: string): void` (`server/public-site/revalidate.ts:14`).
- Produces:
  - `export const STREAM_HOSTS: readonly string[]` (the **eleven** hostnames — R16's ten plus `m.youtube.com`, owner answer 16 / Q5: *"Agree"*. R16 was written before that answer and says ten; this plan wins, and `_INDEX.md` records the widening.)
  - `export const streamUrlSchema: z.ZodType<string | null, string | null>` — parses `string | null`, returns `string | null`
  - `export function isStreamUrl(value: string): boolean`
  - `export const PutFixtureStream` / `export type PutFixtureStream = { streamUrl: string | null }` (schemas.ts)
  - `export const FixtureStream` / `export type FixtureStream = { id: string; stream_url: string | null }` (schemas.ts)
  - `export async function setFixtureStreamUrl(auth: AuthCtx, id: string, streamUrl: string | null): Promise<FixtureStreamOut>` where `export interface FixtureStreamOut { id: string; stream_url: string | null }` (usecases/fixtures.ts)
  - `PublicFixture.stream_url: string | null`

- [ ] **Step 1: Write the failing validation test.** Create `apps/web/src/lib/__tests__/stream-url.test.ts`:

```ts
// R16: exact hostname, https only. A prefix or substring test is not origin
// validation — this repo has already shipped `/\evil.com` as an open redirect
// off exactly that mistake, so the negative cases below are the point of the
// file and the positives exist only so a schema that rejected everything
// could not pass for a correct one.
import { describe, expect, it } from "vitest";
import { STREAM_HOSTS, isStreamUrl, streamUrlSchema } from "@/lib/stream-url";

const ACCEPTED = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://youtube.com/live/abc123",
  "https://youtu.be/abc123",
  // Owner answer 16 (Q5): "Agree". A club that copies the link out of the
  // YouTube phone app pastes this host, did nothing wrong, and was being told
  // its own link was invalid. A real YouTube host, so the widening is exact.
  "https://m.youtube.com/watch?v=abc123",
  "https://www.facebook.com/clubpage/videos/123",
  "https://facebook.com/clubpage/live",
  "https://fb.watch/aBc-1/",
  "https://www.twitch.tv/seaznclub",
  "https://twitch.tv/seaznclub",
  "https://kick.com/seaznclub",
  "https://www.kick.com/seaznclub",
];

const REJECTED: [string, string][] = [
  ["https://evil.example/www.youtube.com", "an allowed host in the PATH is not the host"],
  ["https://www.youtube.com.evil.example/", "an allowed host as a PREFIX of the host is not the host"],
  ["https://youtube.com.evil.example", "same, without the www"],
  ["https://notyoutube.com/x", "an allowed host as a SUFFIX of the host is not the host"],
  ["javascript:alert(1)", "not https"],
  ["http://www.youtube.com/x", "http is refused even on an allowed host"],
  // `m.youtube.com` is now ACCEPTED (owner answer 16 / Q5) and has moved to
  // the list above. Its LOOK-ALIKE stays rejected here, which is the pair that
  // proves the widening added one exact hostname rather than a `youtube.com`
  // suffix rule — delete this row and the widening is indistinguishable from
  // an `endsWith` that would also accept `m.youtube.com.evil.example`.
  ["https://m.youtube.com.evil.example/x", "the new host as a PREFIX of the host is still not the host"],
  ["https://mm.youtube.com/x", "a near-miss subdomain of an allowed host is not on the list"],
  [" https://youtube.com", "a leading space is not trimmed into validity"],
  ["https://user:pass@www.youtube.com/x", "credentials in the authority"],
  ["not a url at all", "unparseable"],
];

describe("STREAM_HOSTS", () => {
  it("is exactly the eleven hostnames — R16's ten plus m.youtube.com — and nothing else", () => {
    expect([...STREAM_HOSTS].sort()).toEqual([
      "facebook.com", "fb.watch", "kick.com", "m.youtube.com", "twitch.tv",
      "www.facebook.com", "www.kick.com", "www.twitch.tv", "www.youtube.com",
      "youtu.be", "youtube.com",
    ]);
  });
});

describe("streamUrlSchema", () => {
  it.each(ACCEPTED)("accepts %s and returns it unchanged", (url) => {
    expect(streamUrlSchema.parse(url)).toBe(url);
    expect(isStreamUrl(url)).toBe(true);
  });

  it.each(REJECTED)("rejects %s — %s", (url) => {
    expect(() => streamUrlSchema.parse(url)).toThrow();
    expect(isStreamUrl(url)).toBe(false);
  });

  it("clears the link on an empty string and passes null through", () => {
    expect(streamUrlSchema.parse("")).toBeNull();
    expect(streamUrlSchema.parse("   ")).toBeNull();
    expect(streamUrlSchema.parse(null)).toBeNull();
  });

  it("names the field in its issue so the panel can render an inline error", () => {
    const parsed = streamUrlSchema.safeParse("https://evil.example/www.youtube.com");
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.code).toBe("custom");
  });
});
```

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/stream-url.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t3a-red.json`
  Expected: collection failure — `Failed to resolve import "@/lib/stream-url"`, `numTotalTests: 0`.

- [ ] **Step 3: Implement the schema.** Create `apps/web/src/lib/stream-url.ts`:

```ts
// The ONE stream-link validator (R16), shared by the write route and the
// organiser panel's inline error. No `server-only`: the panel is a client
// component and must validate before it sends.
//
// EXACT hostname comparison. Never `startsWith`, never `includes`, never a
// regex over the whole URL: `https://evil.example/www.youtube.com` and
// `https://www.youtube.com.evil.example/` both contain an allowed host and
// neither IS one. `new URL()` is what separates the authority from the rest;
// this file's whole job is to compare `url.hostname` against a fixed set.
import { z } from "zod";

export const STREAM_HOSTS = [
  "www.youtube.com",
  "youtube.com",
  "youtu.be",
  // Owner answer 16 (Q5), 2026-09-06: "Agree". YouTube's mobile host — what
  // the phone app's share sheet produces. Exact hostname like every other
  // entry; it widens the set by ONE name, not by a `youtube.com` suffix rule.
  "m.youtube.com",
  "www.facebook.com",
  "facebook.com",
  "fb.watch",
  "www.twitch.tv",
  "twitch.tv",
  "kick.com",
  "www.kick.com",
] as const;

const ALLOWED = new Set<string>(STREAM_HOSTS);

/** True when `value` is an https URL whose hostname is EXACTLY one of the eleven.
 *  Credentials in the authority are refused too — a link a club pastes into a
 *  public page must not carry a username. */
export function isStreamUrl(value: string): boolean {
  if (value !== value.trim()) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return ALLOWED.has(url.hostname);
}

/**
 * `""` (or whitespace) clears the link; `null` passes through; anything else
 * must satisfy `isStreamUrl`. The transform runs BEFORE the refinement so an
 * empty string never reaches the host check.
 */
export const streamUrlSchema = z
  .union([z.string(), z.null()])
  .transform((v) => (v === null || v.trim() === "" ? null : v))
  .refine((v) => v === null || isStreamUrl(v), {
    message: "Stream link must be an https link to YouTube, Facebook, Twitch or Kick",
  });
```

- [ ] **Step 4: Run — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/stream-url.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t3a-green.json`
  Expected: `numFailedTests: 0`, `numTotalTests: 26` (11 accepted + 11 rejected + 4).

- [ ] **Step 5: Mutation check (a) — delete the hostname comparison.** Change `return ALLOWED.has(url.hostname);` to `return true;`, re-run Step 4. Expected red: all ten `rejects …` cases for the https ones — `expected [Function] to throw an error`. Restore and re-run to green. Record "mutant (a) killed by stream-url.test.ts › rejects https://evil.example/www.youtube.com".

- [ ] **Step 6: Write the migration.** Create `db/migration/deltas/V400__fixture_stream_url.sql` (renumber at rebase, R10):

```sql
-- =============================================================================
-- V400 — Stream overlay W1: the club's own broadcast link on a fixture.
--
-- A club streams the match to YouTube / Facebook / Twitch / Kick and pastes the
-- link here; the public match page turns it into "Watch live" (and "Replay"
-- once decided). Video never touches seazn — this is a text column and an
-- anchor. Exact-host validation lives in `apps/web/src/lib/stream-url.ts`
-- (R16); the CHECK below is the database's own floor, not a substitute for it.
--
-- The view is redefined IN FULL with `stream_url` appended LAST: `create or
-- replace view` may only APPEND columns (V243's note, V369's note, still true).
-- The body below is V369__public_fixtures_round_role.sql:18 verbatim plus the
-- one trailing column, which carries the same per-row "setup" redaction the
-- scheduled_at/venue/court_label columns already use — an unreleased
-- division's stream link must not leak ahead of its schedule.
-- =============================================================================

alter table fixtures add column if not exists stream_url text
  check (stream_url is null or stream_url like 'https://%');

create or replace view public_fixtures_v as
  select f.id, f.division_id, f.stage_id, f.pool_id, f.round_no, f.seq_in_round,
         f.home_entrant_id, f.away_entrant_id,
         case when d.status = 'setup' then null else f.scheduled_at end as scheduled_at,
         case when d.status = 'setup' then null else f.venue end        as venue,
         case when d.status = 'setup' then null else f.court_label end as court_label,
         f.status, f.outcome, f.created_at,
         m.summary, m.last_seq,
         case when d.officials_hide_names or d.status = 'setup'
              then '[]'::jsonb else f.officials end as officials,
         f.home_slot_label, f.away_slot_label,
         f.lane, f.is_final, f.third_place, f.conditional,
         case when d.status = 'setup' then null else f.stream_url end as stream_url
  from fixtures f
  left join match_states m on m.fixture_id = f.id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');
```

- [ ] **Step 7: Apply it and prove the column is on the view.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npm run db:apply`
  then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npx tsx -e "import postgres from 'postgres'; const s = postgres(process.env.DATABASE_URL!, { ssl: false }); const r = await s\`select column_name, ordinal_position from information_schema.columns where table_name = 'public_fixtures_v' order by ordinal_position desc limit 1\`; console.log(r); await s.end();"`
  Expected: the single row is `{ column_name: 'stream_url', ordinal_position: 22 }` — LAST, which is what proves the append rule was honoured rather than assumed.

- [ ] **Step 8: Widen both hand-maintained column lists.** In `apps/web/src/server/public-site/data.ts`, add to `PublicFixture` (after `conditional`, the last field of the interface at `:206`ff):

```ts
  /** The club's own broadcast link (V400). Null unless an organiser saved one,
   *  and null for a `setup` division — the view redacts it alongside the
   *  schedule. Rendered ONLY as an `<a href target="_blank" rel="noopener">`
   *  (R16); never an iframe, never fetched. */
  stream_url: string | null;
```

  and extend the SELECT inside `getPublicFixture` (`:711-716`) so its last line reads:

```ts
               lane, is_final, third_place, conditional, stream_url
```

  In `apps/web/src/server/usecases/public.ts`, add `| "stream_url"` to `publicFixture()`'s `Pick<>` union (after `| "last_seq"`) and extend its SELECT's last line to:

```ts
             summary, last_seq, stream_url
```

- [ ] **Step 9: Add the wire schemas.** In `apps/web/src/server/api-v1/schemas.ts`, immediately after `export type PatchFixture = z.infer<typeof PatchFixture>;` (`:989`):

```ts
/** PUT /fixtures/{id}/stream (stream overlay W1). `.strict()` for the reason
 *  `PatchFixture` documents: a client sending `stream_url` (snake) instead of
 *  `streamUrl` gets a loud 400 rather than a silent no-op. The value is
 *  validated by the ONE allowlist both this route and the organiser panel
 *  share (`@/lib/stream-url`, R16) — never a second host list here. */
export const PutFixtureStream = z.object({ streamUrl: streamUrlSchema }).strict();
export type PutFixtureStream = z.infer<typeof PutFixtureStream>;

export const FixtureStream = z.object({
  id: z.string(),
  stream_url: z.string().nullable(),
});
export type FixtureStream = z.infer<typeof FixtureStream>;
```

  and add `import { streamUrlSchema } from "@/lib/stream-url";` to the file's import block.

- [ ] **Step 10: Write the failing usecase test.** Create `apps/web/src/server/usecases/__tests__/fixture-stream-url.test.ts`:

```ts
// `setFixtureStreamUrl` against a real Postgres (the `HAS_DB` skip idiom,
// add-fixture.test.ts:5-17). The point is the SEAM, not the setter: a value
// written here must arrive on `public_fixtures_v`, because `PublicFixture`'s
// column list is hand-maintained in two places and a column read everywhere /
// written nowhere is this repo's most-shipped defect class.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { seedOrg, startedDivisionWithFixture } from "./_rig";
import { setFixtureStreamUrl } from "../fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("setFixtureStreamUrl", () => {
  it("writes the link, returns it, and it arrives on the PUBLIC view", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const url = "https://www.youtube.com/watch?v=abc123";

    const saved = await setFixtureStreamUrl(auth, fixtureId, url);
    expect(saved).toEqual({ id: fixtureId, stream_url: url });

    const [base] = await sql<{ stream_url: string | null }[]>`
      select stream_url from fixtures where id = ${fixtureId}`;
    expect(base?.stream_url).toBe(url);

    const [view] = await sql<{ stream_url: string | null }[]>`
      select stream_url from public_fixtures_v where id = ${fixtureId}`;
    expect(view?.stream_url, "V400 appended the column to the view — this is the seam").toBe(url);
  });

  it("clears the link with null", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    await setFixtureStreamUrl(auth, fixtureId, "https://twitch.tv/seaznclub");
    const cleared = await setFixtureStreamUrl(auth, fixtureId, null);
    expect(cleared.stream_url).toBeNull();
    const [row] = await sql<{ stream_url: string | null }[]>`
      select stream_url from fixtures where id = ${fixtureId}`;
    expect(row?.stream_url).toBeNull();
  });

  it("404s an id that is not this org's fixture, rather than writing nothing and reporting success", async () => {
    const { auth } = await seedOrg();
    const other = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(other.auth);
    await expect(setFixtureStreamUrl(auth, fixtureId, "https://kick.com/x")).rejects.toBeInstanceOf(HttpError);
  });

  it("refuses a host outside the allowlist at the usecase boundary too, not only at the route", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    await expect(
      setFixtureStreamUrl(auth, fixtureId, "https://evil.example/www.youtube.com"),
    ).rejects.toBeInstanceOf(HttpError);
    const [row] = await sql<{ stream_url: string | null }[]>`
      select stream_url from fixtures where id = ${fixtureId}`;
    expect(row?.stream_url, "a refused link must leave the column untouched").toBeNull();
  });
});
```

- [ ] **Step 11: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/fixture-stream-url.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t3b-red.json`
  Expected: collection failure — `"setFixtureStreamUrl" is not exported by "src/server/usecases/fixtures.ts"`. If instead you see `numTotalTests: 4, numPassedTests: 0, numPendingTests: 4`, `DATABASE_URL` is unset and the suite SKIPPED — fix the env, do not accept the skip.

- [ ] **Step 12: Implement the usecase.** In `apps/web/src/server/usecases/fixtures.ts`, immediately after `patchFixture`'s closing brace (`:176`):

```ts
/** The row `PUT /fixtures/{id}/stream` returns and the panel reads back. */
export interface FixtureStreamOut {
  id: string;
  stream_url: string | null;
}

/**
 * Set or clear a fixture's public broadcast link (stream overlay W1).
 *
 * Validated HERE as well as at the route, against the SAME schema the panel
 * uses (`@/lib/stream-url`, R16) — a usecase that trusts its caller is one
 * `parseBody` refactor away from writing an unvalidated host into a public
 * anchor. `withTenant` scopes the write; a fixture belonging to another org is
 * simply not found, which is also the answer for an id that does not exist.
 *
 * The revalidation is `fireDivisionRevalidate` (revalidate.ts:14), NOT
 * `broadcastRevalidate` — the latter is the peer primitive that helper calls
 * internally. It is what busts the `["pub-fixture", fixtureId]` cache entry
 * tagged `divisionTag(division.id)` (data.ts:742), which is the entry the
 * public match page reads the link from.
 */
export async function setFixtureStreamUrl(
  auth: AuthCtx,
  id: string,
  streamUrl: string | null,
): Promise<FixtureStreamOut> {
  rejectDeviceLink(auth);
  const parsed = streamUrlSchema.safeParse(streamUrl);
  if (!parsed.success) throw new HttpError(422, "invalid stream link");
  const value = parsed.data;
  const out = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string; stream_url: string | null; division_id: string; competition_id: string }[]>`
      update fixtures f
         set stream_url = ${value}
        from divisions d
       where f.id = ${id} and d.id = f.division_id
      returning f.id, f.stream_url, f.division_id, d.competition_id`;
    if (!row) throw new HttpError(404, "fixture not found");
    return row;
  });
  fireDivisionRevalidate(out.division_id, out.competition_id);
  return { id: out.id, stream_url: out.stream_url };
}
```

  and add to the file's imports: `import { streamUrlSchema } from "@/lib/stream-url";` and `import { fireDivisionRevalidate } from "../public-site/revalidate";`.

- [ ] **Step 13: Run — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/fixture-stream-url.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t3b-green.json`
  Expected: `numTotalTests: 4`, `numFailedTests: 0`, `numPendingTests: 0`.

- [ ] **Step 14: Add the route.** Create `apps/web/src/app/api/v1/fixtures/[id]/stream/route.ts`:

```ts
import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PutFixtureStream } from "@/server/api-v1/schemas";
import { setFixtureStreamUrl } from "@/server/usecases/fixtures";

type Ctx = { params: Promise<{ id: string }> };

/** The club's own broadcast link (stream overlay W1). Same write gate the
 *  schedule PATCH uses — `requireResourceAuth(req, "fixture", id, "write")`
 *  (fixtures/[id]/route.ts:17) — because pasting a public link on a fixture is
 *  the same authority as moving it. Returns JSON; never a redirect (R8). */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PutFixtureStream);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return setFixtureStreamUrl(auth, id, body.streamUrl);
  });
}
```

- [ ] **Step 15: Declare it in OpenAPI and in the key-scope map.** In `apps/web/src/server/api-v1/openapi.ts`, immediately after the `PATCH /fixtures/{id}` row (`:142`):

```ts
  { path: "/fixtures/{id}/stream", method: "put", summary: "Set or clear the fixture's public broadcast link (https, exact-host allowlist: YouTube, Facebook, Twitch, Kick) — surfaces as \"Watch live\" on the public match page", tag: "fixtures", request: S.PutFixtureStream, response: S.FixtureStream, errors: [403, 404, 422] },
```

  In `apps/web/src/server/api-v1/key-scopes.ts`, after `{ method: "PATCH", path: "/fixtures/:id", scope: "manage", pin: "fixture" }` (`:175`):

```ts
  { method: "PUT", path: "/fixtures/:id/stream", scope: "manage", pin: "fixture" },
```

- [ ] **Step 16: Regenerate the spec and run both classification gates.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npm run openapi:gen`
  then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/server/api-v1/__tests__/openapi-coverage.test.ts src/server/api-v1/__tests__/key-scopes.test.ts src/server/api-v1/__tests__/openapi-published.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t3c.json`
  Expected: `numFailedTests: 0`. Both are total-classification tests, so omitting either declaration reds them with the new route named in the diff — run this step BEFORE the declarations if you want to see that red first.
  Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git status --porcelain apps/web/openapi` — expected: both files modified, and re-running `openapi:gen` leaves no further diff (CI's drift gate).

- [ ] **Step 17: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/lib/stream-url.ts apps/web/src/lib/__tests__/stream-url.test.ts db/migration/deltas/V400__fixture_stream_url.sql apps/web/src/server/public-site/data.ts apps/web/src/server/usecases/public.ts apps/web/src/server/api-v1/schemas.ts apps/web/src/server/usecases/fixtures.ts apps/web/src/server/usecases/__tests__/fixture-stream-url.test.ts apps/web/src/app/api/v1/fixtures/[id]/stream/route.ts apps/web/src/server/api-v1/openapi.ts apps/web/src/server/api-v1/key-scopes.ts apps/web/openapi/v1.json apps/web/openapi/v1.public.json`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(data): fixtures.stream_url, the exact-host allowlist and PUT /fixtures/{id}/stream" -m "V400 appends stream_url to public_fixtures_v (append-only, R6); both hand-maintained PublicFixture column lists gain it; the DB-backed usecase test proves the value reaches the public view rather than assuming it." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 4: The entitlement key

**Files:**
- Create: `db/migration/deltas/V401__streaming_entitlements.sql`
- Create (Test): `apps/web/src/lib/__tests__/entitlement-streaming-overlay.test.ts`
- **Not modified, deliberately:** `apps/web/src/lib/entitlement-domains.ts`, `apps/web/src/lib/pricing-matrix.ts`, every pricing dictionary key.

**Interfaces:**
- Consumes: `hasFeature(orgId: string, featureKey: string, competitionId?: string): Promise<boolean>` (`lib/entitlements.ts:454`); `invalidateOrgEntitlements(orgId: string)` (`lib/entitlements.ts`); `ENTITLEMENT_DOMAINS: { slug: string; features: string[] }[]` (`lib/entitlement-domains.ts:5`); `buildPricingSections` (`lib/pricing-matrix.ts:199`); `seedOrg()` (`server/usecases/__tests__/_rig.ts:23`).
- Produces: no new TypeScript symbol — the key is data. `plan_entitlements` gains one row per plan for `streaming.overlay`, all `bool_value = false`.

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/lib/__tests__/entitlement-streaming-overlay.test.ts`:

```ts
// `streaming.overlay` (R1): granted by NO plan, hidden from /pricing by being
// absent from ENTITLEMENT_DOMAINS, lifted for one org by an override row.
//
// Two halves on purpose. The catalogue half is a pure unit — it is the thing a
// later "tidy the domains list" edit would break silently. The resolver half is
// DB-backed, because "false for a fresh org, true after an override" is a claim
// about the real resolver's precedence (entitlements.ts:441 override first),
// not about a constant.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import { ENTITLEMENT_DOMAINS } from "@/lib/entitlement-domains";
import { seedOrg } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;
const KEY = "streaming.overlay";
/** What the test org's override row grants — owner answer 14 (Q3). Both, always:
 *  the overlay's whole promise is a score that keeps up with the picture. */
const GRANTED = [KEY, "realtime"] as const;

describe("streaming.overlay is unadvertised", () => {
  it("is in NO ENTITLEMENT_DOMAINS section — that omission is what keeps it off /pricing", () => {
    const listed = ENTITLEMENT_DOMAINS.flatMap((d) => d.features);
    expect(listed).not.toContain(KEY);
  });

  it("the domains list is otherwise untouched by this wave", () => {
    // A positive pair for the negative above: if a future edit deleted the
    // whole list, the assertion above would pass vacuously.
    expect(ENTITLEMENT_DOMAINS.length).toBeGreaterThanOrEqual(5);
    expect(ENTITLEMENT_DOMAINS.flatMap((d) => d.features)).toContain("embeds.enabled");
  });
});

describe.skipIf(!HAS_DB)("streaming.overlay resolves", () => {
  // Amended 2026-09-07 (design §5.1): V401 seeds BOTH keys, so the catalogue
  // claim is made for both — a migration that forgot `streaming.relay` would
  // leave the Phone tab's gate with no row to flip at GA.
  it.each(["streaming.overlay", "streaming.relay"] as const)("carries a catalogue row for every plan for %s, all false", async (key) => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null }[]>`
      select plan_key, bool_value from plan_entitlements where feature_key = ${key}`;
    const plans = await sql<{ key: string }[]>`select key from plans`;
    expect(rows.length, "a missing row already denies, but /admin needs the key visible under \"other\"")
      .toBe(plans.length);
    expect(plans.length, "the v18 plan set (V393): community, pro, event_pass, event_pass_l, enterprise").toBe(5);
    for (const row of rows) expect(row.bool_value, `${key} on ${row.plan_key}`).toBe(false);
  });

  it("is false for a fresh org and true after an org_entitlement_overrides row", async () => {
    const { auth } = await seedOrg();
    expect(await hasFeature(auth.orgId, KEY), "no plan grants it").toBe(false);

    // Owner answer 14 (Q3), "we are using supabase realtime": the test org's
    // override grants BOTH keys. `/api/v1/public/fixtures/[id]/realtime-token`
    // 403s without `realtime`, and the client then falls back to a 15 s poll —
    // a score that lags the picture by up to fifteen seconds on a live
    // broadcast, which viewers read as our bug. Granting only `streaming.overlay`
    // ships the feature in its broken form. Whether every PLAN that grants one
    // must grant the other is deferred to pricing (Q4) and is deliberately not
    // encoded anywhere in code.
    for (const key of GRANTED) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${auth.orgId}, ${key}, true, 'unit: stream overlay W1')
        on conflict (org_id, feature_key) do update set bool_value = true, expires_at = null`;
    }
    await invalidateOrgEntitlements(auth.orgId);
    expect(await hasFeature(auth.orgId, KEY), "the resolver ranks the override first").toBe(true);
    expect(
      await hasFeature(auth.orgId, "realtime"),
      "without this the overlay polls, and a 15 s-stale score goes out on air",
    ).toBe(true);

    await sql`
      update org_entitlement_overrides set bool_value = false
       where org_id = ${auth.orgId} and feature_key = ${KEY}`;
    await invalidateOrgEntitlements(auth.orgId);
    expect(await hasFeature(auth.orgId, KEY), "and the other direction, so the flip is real").toBe(false);
  });

  it("does not leak into another org", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${a.auth.orgId}, ${KEY}, true, ${"unit " + randomUUID().slice(0, 6)})
      on conflict (org_id, feature_key) do update set bool_value = true`;
    await invalidateOrgEntitlements(a.auth.orgId);
    expect(await hasFeature(b.auth.orgId, KEY)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npx vitest run src/lib/__tests__/entitlement-streaming-overlay.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t4-red.json`
  Expected: the two pure cases PASS (the key is genuinely absent from the domains list today), and `carries a catalogue row for every plan, all false` FAILS with `expected +0 to be 5` (or whatever `select count(*) from plans` returns) — the migration does not exist yet. `numFailedTests: 1`.

- [ ] **Step 3: Write the migration.** Create `db/migration/deltas/V401__streaming_entitlements.sql` (renumber at rebase, R10):

```sql
-- =============================================================================
-- V401 — Streaming W1: the `streaming.overlay` and `streaming.relay` keys
-- (design §5.1, re-pinned 2026-09-07 @ fb99bbd4c; the 09-05 plan wrote V393,
-- which is the entitlements-v18 catalogue on main).
--
-- Both granted by NO plan at launch (dark rollout, design §10.4; the GA flip
-- to §5.1's split — true on pro / event_pass_l / enterprise — is a LATER
-- migration shipped with its pricing copy). A missing row already denies
-- (lib/entitlements.ts's resolver; V024__plan_entitlements.sql:1), so these
-- rows are not what makes the gate work — they are what makes the key VISIBLE
-- in /admin/entitlements under "other", so an operator can see the feature
-- exists before deciding a tier for it.
--
-- The key is deliberately NOT added to `ENTITLEMENT_DOMAINS`
-- (apps/web/src/lib/entitlement-domains.ts) — that catalogue is CODE, and
-- `buildPricingSections` renders only listed keys, so the omission is exactly
-- what keeps a false-everywhere row off the public pricing comparison. Adding
-- it there would render an empty column on every plan.
--
-- The test org is lifted with an `org_entitlement_overrides` row (V025), which
-- the resolver ranks first — SQL, not a migration, so the grant travels with
-- the environment rather than with the schema.
--
-- Derived from `plans` rather than a typed plan list, so a tier added later
-- still gets its explicit deny without an edit here. Same insert form as
-- V290__pro_plus_plan.sql:18,39.
-- =============================================================================

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select p.key, k.feature_key, false, null
from plans p
cross join (values ('streaming.overlay'), ('streaming.relay')) as k(feature_key)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;
```

  RE-PIN at execution (V393 measured its own prose — "measured, not assumed"): `select key from plans order by key` on the ovl DB must list exactly `community, enterprise, event_pass, event_pass_l, pro` (the v18 set; `pro_plus` retired at `V393:145`) — paste the result into the migration header as V393 does, and into `_INDEX.md`.

- [ ] **Step 4: Apply and run — expect PASS.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npm run db:apply`
  then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npx vitest run src/lib/__tests__/entitlement-streaming-overlay.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t4-green.json`
  Expected: `numTotalTests: 5`, `numFailedTests: 0`, `numPendingTests: 0`.

- [ ] **Step 5: Confirm by reading, not by assuming, that no pricing copy is owed.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && grep -an "ENTITLEMENT_DOMAINS" apps/web/src/lib/pricing-matrix.ts`
  Expected: `:196` and `:199` — `buildPricingSections` maps `ENTITLEMENT_DOMAINS` and nothing else. Record in the PR inventory: "no `pricing.feature.streaming.overlay` key added; `buildPricingSections` (pricing-matrix.ts:199) iterates only `ENTITLEMENT_DOMAINS`, which does not list the key."

- [ ] **Step 6: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add db/migration/deltas/V401__streaming_entitlements.sql apps/web/src/lib/__tests__/entitlement-streaming-overlay.test.ts`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(entitlement): streaming.overlay, denied on every plan" -m "V393 writes an explicit false for every plan key so /admin can see the feature; the key stays out of ENTITLEMENT_DOMAINS, which is what keeps it off /pricing (R1). The DB half proves the override flip in both directions." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 5: The overlay route — layout, page, stage, bar, bug, CSS, dictionary

**Files:**
- Modify: `apps/web/src/server/public-site/data.ts` — new export after `getPublicFixture` (`:747`)
- Create: `apps/web/src/app/overlay/fixtures/[fixtureId]/layout.tsx`
- Create: `apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx`
- Create: `apps/web/src/components/overlay/theme-registry.ts` (owner answer 18 / Q7)
- Create (Test): `apps/web/src/components/overlay/__tests__/theme-registry.test.ts`
- Create: `apps/web/src/components/overlay/overlay-stage.tsx`
- Create: `apps/web/src/components/overlay/overlay-bar.tsx`
- Create: `apps/web/src/components/overlay/overlay-bug.tsx`
- Modify: `apps/web/src/app/globals.css` — append after the `:root { --sport-* }` block (`:1022`)
- Modify: `apps/web/src/components/cookie-consent.tsx` — one `data-testid` (`:84`) and the `/overlay/` guard (owner answer 13)
- Create (Test): `apps/web/src/components/__tests__/cookie-consent-overlay-segment.test.tsx`
- Modify: `apps/web/src/dictionaries/{en,fr,es,nl}/public.json`
- Modify (generated): `apps/web/src/lib/i18n-keys.ts`
- Create (Test): `apps/web/src/lib/__tests__/overlay-dict-coverage.test.ts`
- Modify ONLY IF NEEDED (exists from T1 Task 2): `apps/web/src/components/overlay/tokens.ts` — a new `OVERLAY_PAIR_ROLES` row for any pair this task paints that the table lacks; `__tests__/contrast.test.ts` is T1's and is NOT re-created (re-pinned 2026-09-07)

**Interfaces:**
- Consumes: `getPublicFixture(orgSlug, compSlug, divSlug, fixtureId)` (`data.ts:689`); `hasFeature` (`entitlements.ts:454`); `getDictionary(locale, "public"): Promise<Dict>` (`lib/i18n.ts:77`); `t(dict, key, vars)` (`lib/i18n-runtime.ts:30`); `toLocale` (`lib/i18n-constants.ts:42`); `decidedOutcomeTemplates(m: MsgFn)` (`scoring-vocab.ts:1320`) with `msgFor(locale, key, vars)` (`messages-i18n.ts:24`); `sportThemeStyle(skinKey): CSSProperties | undefined` (`sport-theme.ts:557`), `sportThemeAttr(skinKey): string | undefined` (`:553`), `resolveSportPalette(skinKey): SportPalette` (`:515`), `SPORT_TOKENS` (`:77`); `useLiveFixture` (Task 1); `overlayModel`, `OverlayModel`, `OverlaySideInput` (Task 2).
- Produces:
  - `export async function publicFixtureSlugs(fixtureId: string): Promise<{ orgSlug: string; compSlug: string; divSlug: string } | null>` (`data.ts`)
  - `theme-registry.ts` (owner answer 18 / Q7) — `export type ThemeId = "bar" | "bug"`; `export interface OverlayThemeDef { id: ThemeId; labelKey: string; component: ComponentType<{ model: OverlayModel; tick: [boolean, boolean] }>; sports: "all" | readonly string[] }`; `export const OVERLAY_THEMES: Record<ThemeId, OverlayThemeDef>`; `export function defaultThemeFor(sportKey: string): ThemeId`; `export function themesForSport(sportKey: string): readonly OverlayThemeDef[]`; `export function resolveTheme(styleParam: string | undefined, sportKey: string): OverlayThemeDef`; `export function resolveThemeFrom(themes: Readonly<Record<string, OverlayThemeDef>>, styleParam: string | undefined, sportKey: string, fallback: ThemeId): OverlayThemeDef` (the injectable body `resolveTheme` delegates to — exported ONLY so the suitability branch is reachable in a test, see Step 6a)
  - `export interface OverlayStageProps { fixtureId: string; initial: LiveFixtureData; realtime: boolean; sportKey: string; style: ThemeId; sides: [OverlaySideInput, OverlaySideInput]; startLabel: string | null; dict: Record<string, string>; decidedTemplates: DecidedOutcomeTemplates; fit?: boolean }`
  - `export function OverlayStage(props: OverlayStageProps): JSX.Element`
  - `export function OverlayBar(props: { model: OverlayModel; tick: [boolean, boolean] }): JSX.Element`
  - `export function OverlayBug(props: { model: OverlayModel; tick: [boolean, boolean] }): JSX.Element`

> **Resolution of watch-list 1 (recorded):** the overlay URL carries only a fixture id, and `getPublicFixture` needs three slugs. `publicFixtureSlugs` reads them through the `public_*_v` views — the same visibility filter `fixtureRealtimeEligible` already uses (`data.ts:952-961`) — then the existing `getPublicFixture` runs unchanged, so its `["pub-fixture", fixtureId]` cache key and `divisionTag` are untouched. No overload, no second query path for the fixture itself.

- [ ] **Step 1: Write the failing dictionary-coverage test.** Create `apps/web/src/lib/__tests__/overlay-dict-coverage.test.ts`:

```ts
// Every `overlay.*` / `stream.*` key the source actually references exists in
// all four locales (R14). The key list is DERIVED FROM THE SOURCE, never typed
// here: a typed list drifts the moment a component adds a key, and then the
// test proves only that the list matches itself.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..");
const DICT = join(SRC, "dictionaries");
const LOCALES = ["en", "fr", "es", "nl"] as const;

const SCAN_DIRS = [
  join(SRC, "components", "overlay"),
  join(SRC, "components", "v2"),
  join(SRC, "lib"),
  join(SRC, "app", "overlay"),
  join(SRC, "app", "(public)"),
];

function files(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out = out.concat(files(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Every string literal in the source that looks like one of this wave's keys.
 *  Deliberately a literal scan: a key built by concatenation would be missed,
 *  which is why the model builds none (see `headerContext`'s explicit switch). */
function referencedKeys(prefix: string): Set<string> {
  const re = new RegExp(`["'\`](${prefix}\\.[A-Za-z0-9_.]+)["'\`]`, "g");
  const found = new Set<string>();
  for (const dir of SCAN_DIRS) {
    for (const file of files(dir)) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(re)) found.add(m[1]!);
    }
  }
  return found;
}

const dictOf = (locale: string, ns: string): Record<string, string> =>
  JSON.parse(readFileSync(join(DICT, locale, `${ns}.json`), "utf8"));

describe("overlay + panel copy is complete in every locale", () => {
  it("finds the keys at all — a scan that matched nothing would pass vacuously", () => {
    expect(referencedKeys("overlay").size).toBeGreaterThanOrEqual(8);
    expect(referencedKeys("stream").size).toBeGreaterThanOrEqual(12);
  });

  for (const locale of LOCALES) {
    it(`${locale}/public.json carries every overlay.* key the source uses`, () => {
      const dict = dictOf(locale, "public");
      const missing = [...referencedKeys("overlay")].filter((k) => typeof dict[k] !== "string").sort();
      expect(missing, `${locale} is missing these overlay keys`).toEqual([]);
    });

    it(`${locale}/ui.json carries every stream.* key the source uses`, () => {
      const dict = dictOf(locale, "ui");
      const missing = [...referencedKeys("stream")].filter((k) => typeof dict[k] !== "string").sort();
      expect(missing, `${locale} is missing these stream keys`).toEqual([]);
    });
  }

  it("no locale carries an overlay/stream key en has dropped", () => {
    const en = { ...dictOf("en", "public"), ...dictOf("en", "ui") };
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      const other = { ...dictOf(locale, "public"), ...dictOf(locale, "ui") };
      const orphans = Object.keys(other)
        .filter((k) => (k.startsWith("overlay.") || k.startsWith("stream.")) && !(k in en))
        .sort();
      expect(orphans, `${locale} has keys en does not`).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/overlay-dict-coverage.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t5a-red.json`
  Expected: `finds the keys at all` fails — `expected +0 to be greater than or equal to 8` (nothing references an `overlay.*` key yet; `overlay-model.ts` uses them but lives under `lib/` and is scanned, so the count will be non-zero once Task 2 landed — in that case the failing case is the per-locale one, `expected [ 'overlay.chase.need', … ] to deeply equal []`). Read the JSON to see which.

- [ ] **Step 3: Add the overlay copy in all four locales.** Add to `apps/web/src/dictionaries/en/public.json`:

```json
  "overlay.header.live": "Live",
  "overlay.header.ended": "Ended",
  "overlay.header.notStarted": "Not started",
  "overlay.header.set": "Set {n}",
  "overlay.header.game": "Game {n}",
  "overlay.detail.serving": "{side} serving",
  "overlay.detail.card": "{side} {card}",
  "overlay.chase.need": "Need {runs}",
  "overlay.chase.needBalls": "Need {runs} off {balls}",
  "overlay.brand": "seazn",
  "overlay.watchLive": "Watch live",
  "overlay.replay": "Replay"
```

  `fr/public.json`:

```json
  "overlay.header.live": "En direct",
  "overlay.header.ended": "Terminé",
  "overlay.header.notStarted": "Pas commencé",
  "overlay.header.set": "Set {n}",
  "overlay.header.game": "Jeu {n}",
  "overlay.detail.serving": "{side} au service",
  "overlay.detail.card": "{side} {card}",
  "overlay.chase.need": "Besoin de {runs}",
  "overlay.chase.needBalls": "Besoin de {runs} en {balls} balles",
  "overlay.brand": "seazn",
  "overlay.watchLive": "Regarder en direct",
  "overlay.replay": "Revoir"
```

  `es/public.json`:

```json
  "overlay.header.live": "En directo",
  "overlay.header.ended": "Finalizado",
  "overlay.header.notStarted": "Sin empezar",
  "overlay.header.set": "Set {n}",
  "overlay.header.game": "Juego {n}",
  "overlay.detail.serving": "Saca {side}",
  "overlay.detail.card": "{side} {card}",
  "overlay.chase.need": "Faltan {runs}",
  "overlay.chase.needBalls": "Faltan {runs} en {balls} bolas",
  "overlay.brand": "seazn",
  "overlay.watchLive": "Ver en directo",
  "overlay.replay": "Repetición"
```

  `nl/public.json`:

```json
  "overlay.header.live": "Live",
  "overlay.header.ended": "Afgelopen",
  "overlay.header.notStarted": "Niet begonnen",
  "overlay.header.set": "Set {n}",
  "overlay.header.game": "Game {n}",
  "overlay.detail.serving": "{side} serveert",
  "overlay.detail.card": "{side} {card}",
  "overlay.chase.need": "Nog {runs} nodig",
  "overlay.chase.needBalls": "Nog {runs} nodig uit {balls} ballen",
  "overlay.brand": "seazn",
  "overlay.watchLive": "Live kijken",
  "overlay.replay": "Herhaling"
```

  Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && pnpm i18n:gen-keys` and confirm `apps/web/src/lib/i18n-keys.ts` gained the twelve keys — eleven as first planned plus `overlay.chase.needBalls` (owner answer 12). It is GENERATED — never hand-edit it.

- [ ] **Step 4: Add the `.ovl-*` CSS.** Append to `apps/web/src/app/globals.css`, immediately after the `:root { --sport-* }` block (`:1014-1022`). Every value below is `_THEMES.md` §1–§4 and §6 at native 1920×1080 — do not round, do not invent:

```css
/* ─── Stream overlay (W1) ───────────────────────────────────────────────────
   Authored at 1920×1080; the stage scales the whole canvas, so every value
   here is the NATIVE one from _THEMES.md §3 and §4 and none of them are
   responsive. Reads only the seven --sport-* tokens (§2), never a .pad-* rule
   — the pad's classes carry pad layout, and sharing them would couple two
   surfaces that are signed off separately. */
.ovl-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 1920px;
  height: 1080px;
  transform-origin: top left;
  font-variant-numeric: tabular-nums;
  color: var(--sport-ink);
}
.ovl-fit { position: fixed; inset: 0; overflow: hidden; }
.ovl-display { font-family: var(--ps-font-display, var(--font-barlow), "Arial Narrow", system-ui, sans-serif); }
.ovl-label { font-family: var(--font-geist-sans, system-ui, sans-serif); }

/* Theme A — broadcast bar (_THEMES.md §3) */
.ovl-bar { position: absolute; left: 72px; right: 72px; bottom: 54px;
           border-radius: 6px; overflow: hidden;
           box-shadow: 0 21px 66px rgba(0, 0, 0, 0.5); }
.ovl-bar-main { display: flex; align-items: stretch; height: 126px;
                background: var(--sport-board); }
.ovl-live-cell { display: flex; flex-direction: column; justify-content: center;
                 gap: 3px; min-width: 225px; padding: 0 33px;
                 background: var(--sport-board-2); }
.ovl-live-row { display: flex; align-items: center; gap: 12px;
                font-size: 24px; font-weight: 600; letter-spacing: 0.02em; }
.ovl-live-dot { width: 15px; height: 15px; border-radius: 9999px;
                background: #ef4444; box-shadow: 0 0 15px rgba(239, 68, 68, 0.8); }
.ovl-context { font-size: 21px; font-weight: 500;
               color: color-mix(in srgb, var(--sport-ink) 70%, transparent); }
.ovl-team-cell { position: relative; display: flex; align-items: center; gap: 24px;
                 flex: 1 1 auto; min-width: 0; padding: 0 42px; }
.ovl-team-name { font-size: 45px; font-weight: 600; letter-spacing: 0.01em; white-space: nowrap; }
.ovl-team-score { margin-left: auto; font-size: 78px; font-weight: 700; line-height: 1; }
.ovl-team-meta { width: 66px; font-size: 33px; font-weight: 500;
                 color: color-mix(in srgb, var(--sport-ink) 70%, transparent); }
.ovl-divider { width: 1.5px; background: rgba(255, 255, 255, 0.14); }
.ovl-clock-cell { display: flex; align-items: center; padding: 0 33px;
                  font-size: 60px; font-weight: 700; color: var(--sport-led); }
.ovl-brand { display: flex; align-items: center; padding: 0 33px;
             background: var(--sport-board-2); font-size: 30px; font-weight: 600;
             letter-spacing: 0.08em;
             color: color-mix(in srgb, var(--sport-ink) 75%, transparent); }
.ovl-detail-band { display: flex; align-items: center; gap: 33px; height: 51px;
                   padding: 0 33px; font-size: 24px; font-weight: 500;
                   background: color-mix(in srgb, var(--sport-board) 90%, transparent);
                   color: color-mix(in srgb, var(--sport-ink) 92%, transparent); }
.ovl-detail-sep { width: 1.5px; height: 24px; background: rgba(255, 255, 255, 0.2); }
.ovl-detail-emphasis { font-weight: 600; color: var(--sport-ink); }

/* Theme B — corner bug (_THEMES.md §4) */
.ovl-bug { position: absolute; left: 60px; top: 54px; width: 480px;
           border-radius: 12px; overflow: hidden;
           background: var(--sport-board);
           box-shadow: 0 21px 66px rgba(0, 0, 0, 0.5); }
.ovl-bug-header { display: flex; align-items: center; gap: 12px; height: 48px;
                  padding: 0 21px; background: var(--sport-board-2);
                  font-size: 21px; font-weight: 600; }
.ovl-bug-header .ovl-live-dot { width: 13.5px; height: 13.5px; }
.ovl-bug-context { font-size: 19.5px; font-weight: 500;
                   color: color-mix(in srgb, var(--sport-ink) 65%, transparent); }
.ovl-bug-brand { margin-left: auto; font-size: 24px; font-weight: 600;
                 letter-spacing: 0.08em;
                 color: color-mix(in srgb, var(--sport-ink) 70%, transparent); }
.ovl-bug-row { position: relative; display: flex; align-items: center; gap: 18px;
               height: 90px; padding: 0 24px; }
.ovl-bug-code { width: 96px; font-size: 48px; font-weight: 600; }
.ovl-bug-cells { display: flex; gap: 18px; font-size: 39px; font-weight: 600;
                 color: color-mix(in srgb, var(--sport-ink) 70%, transparent); }
.ovl-bug-cell-current { font-weight: 700; color: var(--sport-ink); }
.ovl-bug-score { margin-left: auto; font-size: 69px; font-weight: 700; line-height: 1; }
.ovl-bug-meta { width: 78px; text-align: right; font-size: 30px; font-weight: 500;
                color: color-mix(in srgb, var(--sport-ink) 65%, transparent); }
.ovl-bug-footer { display: flex; align-items: center; justify-content: space-between;
                  height: 45px; padding: 0 24px; font-size: 21px; font-weight: 500;
                  color: color-mix(in srgb, var(--sport-ink) 85%, transparent); }

/* The side in play (both themes): board-2 ground, an LED bar, an LED score. */
.ovl-side-led { background: var(--sport-board-2); }
.ovl-side-led .ovl-team-score,
.ovl-side-led .ovl-bug-score { color: var(--sport-led); }
.ovl-led { position: absolute; background: var(--sport-led);
           transition: transform 200ms ease-in-out; }
.ovl-bar .ovl-led { left: 0; right: 0; bottom: 0; height: 8px; }
.ovl-bug .ovl-led { left: 0; top: 0; bottom: 0; width: 8px; }
.ovl-serve-dot { width: 10.5px; height: 10.5px; border-radius: 9999px;
                 background: var(--sport-led); }

/* Motion — _THEMES.md §6, R13. transform/opacity only; nothing on mount. */
@keyframes ovl-tick { 0% { transform: scale(1); } 45% { transform: scale(1.12); } 100% { transform: scale(1); } }
@keyframes ovl-breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
.ovl-tick { animation: ovl-tick 300ms ease-out; }
.ovl-live-dot { animation: ovl-breathe 2s ease-in-out infinite; }
.ovl-static .ovl-live-dot { animation: none; opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .ovl-tick { animation: none; }
  .ovl-live-dot { animation: none; opacity: 1; }
  .ovl-led { transition: none; }
}

```

> **Deleted by owner answer 13, deliberately.** This block used to end with
> `body:has(.ovl-canvas) [data-testid="cookie-consent"] { display: none }`. The
> owner's answer is *"we can remove"* — the banner must not RENDER on the
> overlay segment, not merely not paint. A `display: none` still mounts the
> component, still runs its effect, and leaves an e2e asserting absence unable
> to tell "hidden" from "gone" (`toBeAttached` would still pass). Steps 4a and
> 4b below replace it with one guard, in one place. Do NOT keep both: two
> guards covering for each other are each untested.

- [ ] **Step 4a: Keep the consent banner off the overlay segment.** In `apps/web/src/components/cookie-consent.tsx`, add `import { usePathname } from "next/navigation";` and, immediately before the existing `if (!visible) return null;`:

```tsx
  // The overlay segment renders no banner (owner answer 13, Q2). OBS
  // composites whatever is painted, so a consent banner burned into a club's
  // broadcast goes out to every viewer until someone dismisses it in the
  // capture browser — and there is nothing to consent to: the segment sets no
  // cookies (Step 4b proves it, rather than asserting it).
  //
  // WHY HERE, and not in the overlay layout. `CookieConsent` is mounted ONCE,
  // in the ROOT layout (`app/layout.tsx:68`), as a SIBLING of `children` — a
  // nested segment layout cannot unmount it. Next's only other route to a
  // banner-free segment is deleting `app/layout.tsx` and giving every route
  // group its own root layout with its own `<html>`, which is a repo-wide
  // restructure for one page. One condition, in the component that owns the
  // decision, is the smallest correct change; `AnalyticsBootstrap`
  // (`analytics-bootstrap.tsx:44`) already reads `usePathname` from this same
  // root-layout position, so the pattern is the tree's, not this wave's.
  if (pathname?.startsWith(OVERLAY_SEGMENT)) return null;
```

  with `const pathname = usePathname();` beside the component's other hooks (hooks before any early return), and, at module scope beside the imports:

```tsx
/** The one route prefix that renders no chrome at all. Named rather than
 *  inlined so a future overlay route cannot forget it. */
const OVERLAY_SEGMENT = "/overlay/";
```

  Keep the `data-testid="cookie-consent"` this task's file list already adds to the wrapper `<div>` (`:84`) — the e2e now asserts the banner is ABSENT on the overlay, and an assertion needs a selector to be absent by.

  Add the unit that fails without the guard — `apps/web/src/components/__tests__/cookie-consent-overlay-segment.test.tsx`:

```tsx
// vitest runs `environment: "node"` here, so this drives the component through
// `renderIsland` with `next/navigation` mocked — a source-scan test (the
// convention the two existing cookie-consent tests use) could not tell a
// rendered banner from a suppressed one, which is the whole claim.
import { describe, expect, it, vi } from "vitest";

const pathname = { current: "/" };
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { CookieConsent } from "../cookie-consent";

describe("CookieConsent on the overlay segment", () => {
  it("renders nothing under /overlay/, so OBS cannot composite it into a broadcast", () => {
    pathname.current = "/overlay/fixtures/11111111-1111-1111-1111-111111111111";
    expect(renderIsland(CookieConsent, {})).toBeNull();
  });

  it("still renders on the public match page — the positive pair", () => {
    // Without this case the assertion above passes on a component that renders
    // nothing anywhere, which is a different (and much worse) bug.
    pathname.current = "/shared/acme/summer-cup/div-a/fixtures/1";
    expect(renderIsland(CookieConsent, {})).not.toBeNull();
  });
});
```

  RE-PIN at execution: `renderIsland`'s signature and whether it returns the rendered element or a handle (`components/__tests__/_hook-harness`, the same helper Task 1 uses). The banner only becomes visible after `needsConsentPrompt()` passes, so the second case may need `localStorage`/consent stubbing — read `cookie-consent-below-dialogs.test.ts` first and use whatever it already does.

- [ ] **Step 4b: Prove the claim the answer rests on — nothing on that segment sets a cookie.** "No consent needed" must be TRUE, not convenient. Two checks, both in `apps/web/e2e/walkthrough/stream-overlay.spec.ts` (Task 8), inside the existing `the page is transparent, carries the seeded score, and is themed` test, which already opens a **fresh anonymous context** (`storageState: { cookies: [], origins: [] }`) — the only starting point from which the assertion means anything:

```ts
    // Owner answer 13 rests on "the overlay sets no cookies". Assert it, in
    // both directions: `document.cookie` cannot see HttpOnly cookies and
    // `context.cookies()` can, so neither check alone is sufficient. PostHog
    // boots from the root layout on every route and is configured
    // `opt_out_persistence_by_default: true` (instrumentation-client.ts:47) —
    // this is what proves that setting still holds on this segment.
    expect(await page.evaluate(() => document.cookie), "the overlay must set no readable cookie").toBe("");
    expect((await anon.cookies()).map((c) => c.name), "nor an HttpOnly one").toEqual([]);

    // And the banner is GONE, not hidden — `toBeAttached`, because a
    // `display: none` rule would satisfy `not.toBeVisible()`.
    await expect(page.getByTestId("cookie-consent")).not.toBeAttached();
```

  If either cookie assertion fails, the answer's premise is false: STOP and record which script set the cookie rather than deleting the assertion — the correct fix is then keeping that script off the segment too, not accepting the banner.

- [ ] **Step 5: Add the slug helper.** In `apps/web/src/server/public-site/data.ts`, after `getPublicFixture` (`:747`):

```ts
/**
 * org / competition / division slugs for a fixture id.
 *
 * The stream-overlay URL carries only a fixture id, but `getPublicFixture`
 * above is keyed on three slugs (and must stay that way — its cache key and
 * its `divisionTag` are shared with the public match page). This resolves them
 * through the SAME `public_*_v` views `fixtureRealtimeEligible` uses (`:952`),
 * so a fixture in a private competition is simply not found here, exactly as
 * it is not found there. Null means 404 for the caller — never a partial.
 */
export async function publicFixtureSlugs(
  fixtureId: string,
): Promise<{ orgSlug: string; compSlug: string; divSlug: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(fixtureId)) return null;
  const [row] = await sql<{ org_slug: string; comp_slug: string; div_slug: string }[]>`
    select o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug
    from public_fixtures_v f
    join public_divisions_v d on d.id = f.division_id
    join public_competitions_v c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where f.id = ${fixtureId} limit 1`;
  if (!row) return null;
  return { orgSlug: row.org_slug, compSlug: row.comp_slug, divSlug: row.div_slug };
}
```

- [ ] **Step 6: Write the layout.** Create `apps/web/src/app/overlay/fixtures/[fixtureId]/layout.tsx`:

```tsx
// The overlay segment's chrome-less shell. A NESTED layout cannot emit
// <html>/<body> — `app/layout.tsx:54` owns the only one, and
// `slideshow/layout.tsx:20` / `embed/layout.tsx:26` are the two precedents for
// returning a <div> instead — so the transparent ground is set by a <style>
// element scoped to this segment rather than by a prop. OBS composites the
// page over the camera, so anything painted here goes on air: no header, no
// footer, no attribution link, and the root layout's consent banner returns
// null on this segment (Step 4a — `usePathname`, not CSS).
//
// RP8 (re-pinned 2026-09-07 @ fb99bbd4c): the display face is the ROOT
// layout's `barlowCondensed` (`lib/fonts.ts:7-9`, variable `--font-barlow`),
// REUSED — never a second `next/font` mount. The existing declaration gains
// weight "800" for W2's slab headline (_THEMES.md §1); `.ovl-display` reads
// `var(--font-barlow)`. Watch-list 7 (double mount) is closed by construction
// and still verified in Step 12 by reading the built CSS.
import { barlowCondensed } from "@/lib/fonts";

export default function OverlayLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={barlowCondensed.variable}>
      <style>{"html,body{background:transparent;margin:0}"}</style>
      {children}
    </div>
  );
}
```

  And in `apps/web/src/lib/fonts.ts:8`, `weight: ["600", "700"],` → `weight: ["600", "700", "800"],` with the comment `// 800: the stream overlay's W2 moment slab (_THEMES.md §1, RP8)`. That is the ONLY edit to that file; the console and marketing keep their own instances.

> **Owner answer 18 (Q7), 2026-09-06 — the ruling this task is now built on.**
> *"we will have multiple theme per sports so make it abstract and use can choose
> for now apply the default one."* Not the yes/no that was asked; a design change.
> Themes stop being a two-value union and become a REGISTRY. Steps 6a–6d below
> build it, Step 7's page resolves through it, Step 8's stage renders
> `theme.component` instead of branching, and Task 6's tabs map over it. The two
> shipped themes do not change: `bar` is `_THEMES.md` §3, `bug` is §4, and
> cricket still opens on `bar` while every other sport opens on `bug`.

- [ ] **Step 6a: Write the failing registry test.** Create `apps/web/src/components/overlay/__tests__/theme-registry.test.ts`:

```ts
// The theme registry (owner answer 18 / Q7). Four claims, and the fourth is
// the one that matters: the fallback is the SPORT'S default, not a constant.
//
// THE TRAP THIS FILE IS WRITTEN AROUND. On day one BOTH shipped themes are
// `sports: "all"`, so a suitability test written against `OVERLAY_THEMES`
// alone cannot witness the `sports` filter at all — it would pass with the
// filter deleted, and mutant (l) would survive. The probe registry below is
// what makes that branch reachable; it is not a mirror, because the FUNCTION
// under test is the shipped one and only its input table is local.
import { describe, expect, it } from "vitest";
import {
  OVERLAY_THEMES,
  defaultThemeFor,
  resolveTheme,
  resolveThemeFrom,
  themesForSport,
  type OverlayThemeDef,
} from "../theme-registry";

// A stand-in component; the registry never renders here.
const Noop = () => null;

/** A registry with a sport-RESTRICTED entry, which the shipped one has none of
 *  today. `cricketOnly` suits cricket and nothing else. */
const PROBE: Record<string, OverlayThemeDef> = {
  bar: { ...OVERLAY_THEMES.bar },
  bug: { ...OVERLAY_THEMES.bug },
  cricketOnly: {
    id: "bar", // id is the registry KEY's type; the probe reuses a real one
    labelKey: "stream.tab.bar",
    component: Noop,
    sports: ["cricket"],
  },
};

describe("defaultThemeFor", () => {
  it("opens cricket on the bar and every other sport on the bug", () => {
    expect(defaultThemeFor("cricket")).toBe("bar");
    for (const key of ["football", "tennis", "badminton", "volleyball", "generic"]) {
      expect(defaultThemeFor(key), key).toBe("bug");
    }
  });

  it("returns a theme that actually suits that sport — a default nothing offers is unreachable", () => {
    for (const key of ["cricket", "football", "tennis", "boardgame", "carrom", "generic"]) {
      const offered = themesForSport(key).map((t) => t.id);
      expect(offered, key).toContain(defaultThemeFor(key));
    }
  });
});

describe("resolveTheme", () => {
  it("resolves a valid id — including one that is NOT that sport's default", () => {
    // Both directions, or "valid id resolves" is indistinguishable from
    // "everything falls back to the default and cricket's happens to be bar".
    expect(resolveTheme("bar", "cricket").id).toBe("bar");
    expect(resolveTheme("bug", "cricket").id).toBe("bug");
    expect(resolveTheme("bar", "football").id).toBe("bar");
    expect(resolveTheme("bug", "football").id).toBe("bug");
  });

  it("falls back on an unknown or misspelt id, and never throws", () => {
    for (const bad of [undefined, "", " ", "BAR", "bugg", "corner-bug", "../etc", "__proto__", "toString"]) {
      expect(() => resolveTheme(bad, "football")).not.toThrow();
      expect(resolveTheme(bad, "football").id, String(bad)).toBe("bug");
    }
  });

  it("falls back when the requested theme does not list the fixture's sport", () => {
    // The probe's `cricketOnly` suits cricket only; football must not get it.
    expect(resolveThemeFrom(PROBE, "cricketOnly", "cricket", defaultThemeFor("cricket")).sports).toEqual(["cricket"]);
    expect(resolveThemeFrom(PROBE, "cricketOnly", "football", defaultThemeFor("football")).id).toBe("bug");
  });

  it("falls back to THE SPORT'S default, not to a hardcoded one", () => {
    // The differential case. Same bad input, two sports, two answers — a
    // `return OVERLAY_THEMES.bug` fallback passes every other test in this file.
    expect(resolveTheme("nonsense", "cricket").id).toBe("bar");
    expect(resolveTheme("nonsense", "football").id).toBe("bug");
    expect(resolveThemeFrom(PROBE, "cricketOnly", "cricket", "bar").id).not.toBe("bug");
  });
});

describe("themesForSport — the console and the route read ONE filter", () => {
  it("offers only themes that suit the sport, and every offered theme resolves back to itself", () => {
    for (const key of ["cricket", "football", "tennis", "volleyball", "boardgame", "generic"]) {
      const offered = themesForSport(key);
      expect(offered.length, key).toBeGreaterThan(0);
      for (const theme of offered) {
        expect(theme.sports === "all" || theme.sports.includes(key), `${key}/${theme.id}`).toBe(true);
        // The seam: a theme the panel shows must be one the route accepts.
        expect(resolveTheme(theme.id, key).id, `${key}/${theme.id}`).toBe(theme.id);
      }
    }
  });

  it("every registered theme carries a label key, and the registry is what the dictionary gate scans", () => {
    for (const theme of Object.values(OVERLAY_THEMES)) {
      expect(theme.labelKey, theme.id).toMatch(/^stream\.tab\./);
      expect(typeof theme.component, theme.id).toBe("function");
    }
    // Both shipped themes today; a third makes this a 3.
    expect(Object.keys(OVERLAY_THEMES).sort()).toEqual(["bar", "bug"]);
  });
});
```

- [ ] **Step 6b: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/components/overlay/__tests__/theme-registry.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t5-reg-red.json`
  Expected: collection failure — `Failed to resolve import "../theme-registry"`, `numTotalTests: 0`.

- [ ] **Step 6c: Write the registry.** Create `apps/web/src/components/overlay/theme-registry.ts`:

```ts
// The overlay's theme registry (owner answer 18 / Q7, 2026-09-06:
// "we will have multiple theme per sports so make it abstract and use can
// choose for now apply the default one").
//
// ONE authority for three facts: which themes exist, which sports each suits,
// and which one a sport opens on. Adding a theme is ONE entry here plus ONE
// component file — the route, the panel and the model are never edited for a
// theme again. `overlay-model.ts` does not import this file and must not: the
// projection is theme-agnostic, which is what lets eleven sports and N themes
// meet in one model.
//
// NOT a `"use client"` module, deliberately. It imports two client components,
// so it becomes part of the client graph where a client component imports it;
// the SERVER page imports only `resolveTheme` and reads `.id` off the result,
// never `.component`, so no component reference crosses the RSC boundary as a
// prop. The stage does the component lookup on the client side of the line.
import type { ComponentType } from "react";
import type { OverlayModel } from "@/lib/overlay-model";
import { OverlayBar } from "./overlay-bar";
import { OverlayBug } from "./overlay-bug";

/** Every theme id the overlay can serve. Declared as an explicit union rather
 *  than derived with `keyof typeof OVERLAY_THEMES`, for two reasons: the page,
 *  the stage's props and the panel's state all need to NAME this type without
 *  importing the registry's value graph, and an explicit union makes a typo'd
 *  registry key a compile error instead of silently widening `ThemeId`. */
export type ThemeId = "bar" | "bug";

export interface OverlayThemeDef {
  id: ThemeId;
  /** `ui` namespace, e.g. `stream.tab.bar`. The panel renders it through
   *  `useMsg` in all four locales; the dictionary coverage test finds it here
   *  because `components/overlay` is one of its SCAN_DIRS. Never English. */
  labelKey: string;
  component: ComponentType<{ model: OverlayModel; tick: [boolean, boolean] }>;
  /** `"all"`, or the exact `sport_key` values this theme is designed for. A
   *  theme is offered in the console and accepted by the route only where this
   *  says so — one filter, so the two cannot disagree. */
  sports: "all" | readonly string[];
}

export const OVERLAY_THEMES: Record<ThemeId, OverlayThemeDef> = {
  bar: { id: "bar", labelKey: "stream.tab.bar", component: OverlayBar, sports: "all" },
  bug: { id: "bug", labelKey: "stream.tab.bug", component: OverlayBug, sports: "all" },
};

/** Which theme a sport OPENS on. Unchanged from decision 1 — cricket's chase
 *  and two-innings score want the lower third, a set or period score wants the
 *  tile — but it is one named function now, not a boolean inside the resolver,
 *  so a future per-sport default is one line here. */
export function defaultThemeFor(sportKey: string): ThemeId {
  return sportKey === "cricket" ? "bar" : "bug";
}

function suits(theme: OverlayThemeDef, sportKey: string): boolean {
  return theme.sports === "all" || theme.sports.includes(sportKey);
}

/** What the console offers for this fixture, in registry order. */
export function themesForSport(sportKey: string): readonly OverlayThemeDef[] {
  return Object.values(OVERLAY_THEMES).filter((theme) => suits(theme, sportKey));
}

/** The body, with the registry injected. Exported ONLY so a test can pass a
 *  registry that HAS a sport-restricted theme: both shipped themes are
 *  `sports: "all"`, so the suitability branch is otherwise unreachable and
 *  deleting it would go unnoticed (Step 6d, mutant (l)). Production callers
 *  use `resolveTheme`. */
export function resolveThemeFrom(
  themes: Readonly<Record<string, OverlayThemeDef>>,
  styleParam: string | undefined,
  sportKey: string,
  fallback: ThemeId,
): OverlayThemeDef {
  // `Object.hasOwn`, not `themes[styleParam]`: `?style=toString` would
  // otherwise reach a prototype member and pass the truthiness check.
  const requested =
    styleParam && Object.hasOwn(themes, styleParam) ? themes[styleParam] : undefined;
  if (requested && suits(requested, sportKey)) return requested;
  return OVERLAY_THEMES[fallback];
}

/**
 * The one resolver. An unknown, misspelt or sport-unsuitable `?style=` falls
 * back to the sport's default and NEVER throws: the caller is an OBS browser
 * source in the middle of a live broadcast, and it cannot be asked to correct
 * a typo. A 404 or an exception here would take a club off air over a query
 * string.
 */
export function resolveTheme(styleParam: string | undefined, sportKey: string): OverlayThemeDef {
  return resolveThemeFrom(OVERLAY_THEMES, styleParam, sportKey, defaultThemeFor(sportKey));
}
```

- [ ] **Step 6d: Run — expect PASS, then run the two mutants.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/components/overlay/__tests__/theme-registry.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t5-reg-green.json`
  Expected: `numFailedTests: 0`, `numTotalTests: 8` (2 + 4 + 2).
  Then, one at a time, restoring and re-running to green after each:
  - **Mutant (l) — delete the `sports` filter.** Change `if (requested && suits(requested, sportKey)) return requested;` to `if (requested) return requested;`. Expected red: `falls back when the requested theme does not list the fixture's sport` — `expected 'bar' to be 'bug'`. If this mutant SURVIVES, the probe registry is wrong, not the code.
  - **Mutant (m) — throw on an unknown id.** Replace the fallback `return OVERLAY_THEMES[fallback];` with `throw new Error("unknown theme");`. Expected red: `falls back on an unknown or misspelt id, and never throws` — nine `not.toThrow()` failures — and `falls back to THE SPORT'S default, not to a hardcoded one`.
  - **Mutant (n) — hardcode the fallback.** Replace `defaultThemeFor(sportKey)` in `resolveTheme` with `"bug"`. Expected red: `falls back to THE SPORT'S default, not to a hardcoded one` — `expected 'bug' to be 'bar'`. This is the mutant the per-sport default exists for; without the cricket/football differential row it survives.

- [ ] **Step 7: Write the page.** Create `apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx`:

```tsx
// The transparent per-fixture overlay a club adds to OBS as a Browser source.
//
// Two gates, both server-side, both `notFound()` so a non-entitled org is
// indistinguishable from a missing fixture (R1): the public visibility rules
// (via `publicFixtureSlugs` + `getPublicFixture`, the same reads the public
// match page makes) and the `streaming.overlay` entitlement. The client never
// decides. No redirect anywhere on this route (R8).
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicFixture, publicFixtureSlugs } from "@/server/public-site/data";
import { hasFeature } from "@/lib/entitlements";
import { getDictionary } from "@/lib/i18n";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { overlayStartLabel } from "@/lib/overlay-model";
import { loadOverlayLiveData } from "@/server/overlay/load";
import { OverlayStage } from "@/components/overlay/overlay-stage";
import { resolveTheme } from "@/components/overlay/theme-registry";

export const metadata: Metadata = { robots: { index: false, follow: false } };

// ISR on the same window as the public match page; the live numbers come from
// the client transport, not from a rerender.
export const revalidate = 30;
export async function generateStaticParams() {
  return [];
}

type Params = { fixtureId: string };
type Query = { style?: string; lang?: string };

export default async function OverlayPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Query>;
}) {
  const { fixtureId } = await params;
  const { style, lang } = await searchParams;

  const slugs = await publicFixtureSlugs(fixtureId);
  if (!slugs) notFound();
  const data = await getPublicFixture(slugs.orgSlug, slugs.compSlug, slugs.divSlug, fixtureId);
  if (!data) notFound();
  const { org, competition, division, fixture, entrantNames, realtime, venueTz } = data;

  // Competition-scoped, like every other spectator-side entitlement read here:
  // an Event Pass grants for the competition it was bought for.
  if (!(await hasFeature(org.id, "streaming.overlay", competition.id))) notFound();

  // `?lang` wins for a club broadcasting in a language other than the org's
  // own public locale; the org's default is the fallback, as on every public
  // surface.
  const locale = toLocale(lang ?? org.default_locale);
  const dict = (await getDictionary(locale, "public")) as Record<string, string>;

  const sides: [
    { id: string; name: string },
    { id: string; name: string },
  ] = [
    {
      id: fixture.home_entrant_id ?? "home",
      name: fixture.home_entrant_id ? (entrantNames[fixture.home_entrant_id] ?? "—") : "—",
    },
    {
      id: fixture.away_entrant_id ?? "away",
      name: fixture.away_entrant_id ? (entrantNames[fixture.away_entrant_id] ?? "—") : "—",
    },
  ];

  // Formatted HERE, where the locale is, through the ONE formatter
  // (`overlayStartLabel`, Task 2) and the VENUE zone Task 0 puts on the payload
  // — never UTC, and never `Intl` inlined at this call site.
  const startLabel = overlayStartLabel(fixture.scheduled_at, locale, venueTz);

  // First paint from the SAME contract the stage polls (Task 0, design §3.2):
  // the cached public row plus the folded-state clock/innings, one fold per
  // last_seq. `venueTz` here and on `initial` come from the same
  // `resolveVenueTz` call chain; the page keeps `getPublicFixture`'s copy for
  // the start label because that read already happened for the gate.
  const initial = await loadOverlayLiveData(fixture.id);

  return (
    <OverlayStage
      fixtureId={fixture.id}
      initial={initial}
      realtime={realtime}
      sportKey={division.sport_key}
      // Owner answer 18 (Q7): resolved against the REGISTRY, and only the id
      // crosses to the client — never the theme's `component`, which would be
      // a React element type travelling as an RSC prop. An unknown, misspelt
      // or sport-unsuitable `?style=` lands on this sport's default rather
      // than erroring: an OBS browser source cannot fix a typo mid-match.
      style={resolveTheme(style, division.sport_key).id}
      sides={sides}
      startLabel={startLabel}
      dict={dict}
      decidedTemplates={decidedOutcomeTemplates((k, v) => msgFor(locale, k, v))}
      fit
    />
  );
}
```

> **Closed, not a gap (owner answer 12, 2026-09-06).** `startLabel` used to format in `UTC` here, recorded as deviation 4 and as an owner question, because no IANA zone reached the public payload. Task 0 puts one there — `venueTz`, the VENUE lane (`resolveVenueTz`, "one zone per fixture"), resolved server-side where the division and org rows already are — and this page now formats through `overlayStartLabel`. Do not reintroduce a `timeZone: "UTC"` literal on this route.

- [ ] **Step 8: Write the stage.** Create `apps/web/src/components/overlay/overlay-stage.tsx`:

```tsx
"use client";
// The overlay's one client island: transport + projection + the three motions.
//
// Authored at a fixed 1920×1080 canvas and scaled with
// `transform: scale(min(vw/1920, vh/1080))` from the top-left (R15), so OBS at
// 1080p renders 1:1 and the organiser panel's preview renders THE SAME
// COMPONENT at a smaller scale rather than a picture of it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { sportThemeAttr, sportThemeStyle } from "@/components/v2/scorepad/v3/sport-theme";
import { useLiveFixture } from "@/components/public-site/use-live-fixture";
import { fetchOverlayFixture, type OverlayLiveData } from "@/components/public-site/live-score-data";
import { overlayModel, type OverlayModel, type OverlaySideInput } from "@/lib/overlay-model";
import { useOverlayClock } from "./use-overlay-clock";
import { t } from "@/lib/i18n-runtime";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
// Owner answer 18 (Q7): the stage knows the REGISTRY, not two components. It
// imports neither `overlay-bar` nor `overlay-bug` — registering a third theme
// must not touch this file, and an import here would be exactly that edit.
import { OVERLAY_THEMES, type ThemeId } from "./theme-registry";

export interface OverlayStageProps {
  fixtureId: string;
  /** The overlay endpoint's payload (Task 0, design §3.2) — the SAME shape the
   *  stage polls, so first paint and every refresh render one contract. */
  initial: OverlayLiveData;
  realtime: boolean;
  sportKey: string;
  /** A registry id, already resolved server-side by `resolveTheme` (Step 6c).
   *  The stage never validates: by the time a value reaches this prop it has
   *  been through the resolver, and a `ThemeId` that is not a registry key is
   *  a compile error. */
  style: ThemeId;
  sides: [OverlaySideInput, OverlaySideInput];
  startLabel: string | null;
  /** The `public` namespace, en-merged server-side. A plain object, so the
   *  island carries only the active locale. */
  dict: Record<string, string>;
  decidedTemplates: DecidedOutcomeTemplates;
  /** True on the overlay route: fill the viewport. False in the console
   *  preview, which sets its own scale on the wrapper. */
  fit?: boolean;
}

/** The previous render's value, for the tick comparison. A ref, not state:
 *  the comparison must not itself cause a render (R13 — nothing animates on
 *  mount, and a render loop would restart the animation every frame). */
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

export function OverlayStage(props: OverlayStageProps) {
  // One transport, two payloads (Task 1): the overlay endpoint is this
  // stage's fetcher; `LiveScore` keeps the public JSON. `presentationNowOffsetMs`
  // is 0 until R2 passes `delayMs` — the clock subtracts it either way.
  const { data, presentationNowOffsetMs } = useLiveFixture(props.fixtureId, props.initial, props.realtime, {
    fetcher: fetchOverlayFixture,
  });
  // The ONE timer in the overlay (Step 8a; _THEMES.md §6; owner 2026-09-06:
  // the clock TICKS). Formatted here, handed to the pure model as a string.
  const clockLabel = useOverlayClock(data.clock, data.status, presentationNowOffsetMs);

  const model: OverlayModel = overlayModel({
    sportKey: props.sportKey,
    data,
    sides: props.sides,
    startLabel: props.startLabel,
    clockLabel,
    msg: (key, vars) => t(props.dict, key, vars),
    decidedTemplates: props.decidedTemplates,
  });

  // Score tick: the ONE `big` that changed, and only that one (R13). Held in
  // state and cleared on a 300 ms timer so re-adding the class re-triggers the
  // animation; a bare CSS class on a value that changes twice inside 300 ms
  // would not restart it.
  const previous = usePrevious(model.sides.map((s) => s.big).join(" "));
  const [tick, setTick] = useState<[boolean, boolean]>([false, false]);
  useEffect(() => {
    if (previous === undefined) return; // never on mount — OBS shows the page mid-stream
    const before = previous.split(" ");
    const next: [boolean, boolean] = [
      before[0] !== model.sides[0].big,
      before[1] !== model.sides[1].big,
    ];
    if (!next[0] && !next[1]) return;
    setTick(next);
    const timer = setTimeout(() => setTick([false, false]), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.sides[0].big, model.sides[1].big]);

  // Canvas scale. useLayoutEffect so the first paint is already at the right
  // size — a visible resize would be an entrance animation, which R13 forbids.
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    if (!props.fit) return;
    const measure = () => setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [props.fit]);

  // The registry lookup, and the ONLY place a theme becomes a component. A
  // `props.style === "bar" ? <OverlayBar/> : <OverlayBug/>` branch is what the
  // owner's answer replaces: a third theme would have had to edit it.
  const Theme = OVERLAY_THEMES[props.style].component;

  return (
    <div className={props.fit ? "ovl-fit" : undefined}>
      <div
        data-testid="ovl-root"
        data-style={props.style}
        data-sport-theme={sportThemeAttr(props.sportKey)}
        data-led={model.sides[0].led ? "home" : model.sides[1].led ? "away" : "none"}
        className={`ovl-canvas ovl-label${model.live ? "" : " ovl-static"}`}
        style={{ ...sportThemeStyle(props.sportKey), transform: `scale(${scale})` }}
      >
        <Theme model={model} tick={tick} />
        {/* W2's slab attaches here (R4). Empty and unstyled in W1. */}
        <div data-testid="ovl-moment-slot" />
      </div>
    </div>
  );
}
```

- [ ] **Step 8a (amended 2026-09-07 — owner ruling 2026-09-06: the football clock ships in W1 and TICKS): the one timer.** Create `apps/web/src/components/overlay/__tests__/use-overlay-clock.test.ts` FIRST:

```ts
// The overlay's ONE timer (_THEMES.md §6, design §3.6). A match clock is DATA:
// the engine stamps `asOf` only when something is scored or a period turns,
// so left alone the cell freezes for minutes and reads as broken on air. This
// hook advances the display from the endpoint's anchor plus elapsed wall time,
// re-anchors on every push, HOLDS at half-time (the endpoint omits `clock`
// while no play phase is running), shows nothing before kick-off or after
// full-time, and subtracts the transport's presentation offset so a delayed
// goal and the clock land together (R2's alignment, unit-level here).
//
// `environment: "node"` — driven through renderIsland with setInterval and
// Date.now stubbed, the idiom live-score.test.tsx and use-live-fixture.test.tsx use.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { useOverlayClock } from "../use-overlay-clock";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

type Clock = OverlayLiveData["clock"];

function stubTick(): { tick: () => void; armed: () => number } {
  let cb: (() => void) | null = null;
  let armed = 0;
  vi.stubGlobal("setInterval", ((fn: () => void, ms?: number) => {
    if (ms !== 1000) throw new Error(`the clock must be 1 Hz, got ${ms}`);
    cb = fn;
    armed += 1;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval);
  vi.stubGlobal("clearInterval", (() => {}) as typeof clearInterval);
  return { tick: () => { if (!cb) throw new Error("no interval armed"); cb(); }, armed: () => armed };
}

function harness(clock: Clock, status: string, offset = 0) {
  let latest: string | null = null;
  const island = renderIsland(
    (p: { clock: Clock; status: string; offset: number }) => {
      latest = useOverlayClock(p.clock, p.status, p.offset);
      return null;
    },
    { clock, status, offset },
  );
  return { island, read: () => latest };
}

const ANCHOR: NonNullable<Clock> = { phase: "H1", anchorSeconds: 761, anchorAtWallMs: 1_000_000 };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("useOverlayClock", () => {
  it("shows the anchor at mount and advances by wall time on each 1 Hz tick", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const h = harness(ANCHOR, "in_play");
    expect(h.read()).toBe("12:41");
    now.mockReturnValue(1_001_000); t.tick();
    expect(h.read()).toBe("12:42");
    now.mockReturnValue(1_017_000); t.tick();
    expect(h.read()).toBe("12:58");
    expect(t.armed()).toBe(1);
  });

  it("re-anchors on a push (a goal re-stamps asOf) instead of drifting from its own count", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const h = harness(ANCHOR, "in_play");
    now.mockReturnValue(1_030_000); t.tick();
    expect(h.read()).toBe("13:11");
    // RE-PIN: the harness's prop-update call (`island.rerender` /
    // `island.update`, _hook-harness.tsx:169+) — use its real name.
    h.island.rerender({ clock: { phase: "H1", anchorSeconds: 1_800, anchorAtWallMs: 1_030_000 }, status: "in_play", offset: 0 });
    expect(h.read()).toBe("30:00");
  });

  it("holds the last displayed value at half-time (clock absent while in_play), and resumes on the next anchor", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const h = harness(ANCHOR, "in_play");
    now.mockReturnValue(1_005_000); t.tick();
    expect(h.read()).toBe("12:46");
    h.island.rerender({ clock: undefined, status: "in_play", offset: 0 });
    expect(h.read(), "half-time: the cell holds, it does not blank").toBe("12:46");
    h.island.rerender({ clock: { phase: "H2", anchorSeconds: 2_700, anchorAtWallMs: 1_900_000 }, status: "in_play", offset: 0 });
    now.mockReturnValue(1_900_000);
    expect(h.read()).toBe("45:00");
  });

  it("shows nothing before kick-off and after the decision, whatever the anchor says", () => {
    stubTick();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(harness(undefined, "scheduled").read()).toBeNull();
    expect(harness(ANCHOR, "decided").read()).toBeNull();
    expect(harness(ANCHOR, "finalized").read()).toBeNull();
  });

  it("subtracts the presentation offset, so under delayMs the clock does not run ahead of the delayed goal", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_010_000);
    const h = harness(ANCHOR, "in_play", 3_000);
    // wall +10 s, offset 3 s → the PICTURE is at +7 s.
    expect(h.read()).toBe("12:48");
    now.mockReturnValue(1_011_000); t.tick();
    expect(h.read()).toBe("12:49");
  });

  it("never runs backwards: a wall clock behind the anchor reads the anchor", () => {
    stubTick();
    vi.spyOn(Date, "now").mockReturnValue(999_000);
    expect(harness(ANCHOR, "in_play").read()).toBe("12:41");
  });
});
```

  Run: `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/components/overlay/__tests__/use-overlay-clock.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t5-clock-red.json` → `Cannot find module '../use-overlay-clock'`. Then create `apps/web/src/components/overlay/use-overlay-clock.ts`:

```ts
"use client";
// The overlay's ONE timer (_THEMES.md §6; design §3.6). Everything else in
// the overlay is CSS. It survives prefers-reduced-motion because it is
// information, not movement.
import { useEffect, useRef, useState } from "react";
import { formatClock } from "@/lib/overlay-model";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

const NO_CLOCK_STATUSES = new Set(["scheduled", "decided", "finalized", "abandoned", "forfeited", "cancelled"]);

/**
 * @param clock  the endpoint's anchor — present only while a play phase is
 *               running (server/overlay/project.ts applies footballPosition's
 *               staleness guard); absent between periods.
 * @param status the fixture status; nothing shows outside `in_play`.
 * @param presentationNowOffsetMs the transport's delay (0 without delayMs) —
 *               the ONE authority for how far behind wall time the picture is.
 */
export function useOverlayClock(
  clock: OverlayLiveData["clock"],
  status: string,
  presentationNowOffsetMs: number,
): string | null {
  const compute = (): string | null => {
    if (!clock) return null;
    const pictureNow = Date.now() - presentationNowOffsetMs;
    const elapsed = Math.max(0, (pictureNow - clock.anchorAtWallMs) / 1000);
    return formatClock(clock.anchorSeconds + elapsed);
  };
  const [label, setLabel] = useState<string | null>(() => (NO_CLOCK_STATUSES.has(status) ? null : compute()));
  const held = useRef<string | null>(label);

  useEffect(() => {
    if (NO_CLOCK_STATUSES.has(status)) {
      held.current = null;
      setLabel(null);
      return;
    }
    // Half-time / full-time: the endpoint omits `clock`. HOLD what was last
    // shown — a cell that blanks at the whistle reads as broken.
    if (!clock) {
      setLabel(held.current);
      return;
    }
    const tick = () => {
      const next = compute();
      held.current = next;
      setLabel(next);
    };
    tick(); // re-anchor immediately on every push
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `compute` closes over exactly these
  }, [clock?.phase, clock?.anchorSeconds, clock?.anchorAtWallMs, status, presentationNowOffsetMs]);

  return label;
}
```

  Re-run: 6 passed. RE-PIN: `VOID_STATUSES` is exported from `stages-panel.tsx` (design §3.4) — if importing it into a client hook drags the whole panel module in, keep the local set and add a unit that asserts it EQUALS `["scheduled", "decided", "finalized", ...VOID_STATUSES]` (one authority, proven, not duplicated silently). Mutants j2 and j3 (Self-review) are killed by `subtracts the presentation offset…` and `holds the last displayed value…` — run both, restore, record.

- [ ] **Step 9: Write the two skins.** Create `apps/web/src/components/overlay/overlay-bar.tsx`:

```tsx
"use client";
// Theme A — the TV lower third (_THEMES.md §3). Every size, colour and inset
// is a class in globals.css's `.ovl-*` block, which carries the sheet's native
// values; nothing is styled inline here except the LED bar's slide, which is a
// transform the CSS transitions.
import type { OverlayModel } from "@/lib/overlay-model";

export function OverlayBar({ model, tick }: { model: OverlayModel; tick: [boolean, boolean] }) {
  return (
    <div className="ovl-bar">
      <div className="ovl-bar-main">
        <div className="ovl-live-cell">
          <span className="ovl-live-row">
            {model.live ? <span data-testid="ovl-live-dot" className="ovl-live-dot" /> : null}
            {model.header.context}
          </span>
          {model.cells.length > 0 ? (
            <span data-testid="ovl-cells" className="ovl-context">
              {model.cells.map((c) => c.value).join("  ")}
            </span>
          ) : null}
        </div>
        {([0, 1] as const).map((row) => {
          const side = model.sides[row];
          return (
            <div
              key={side.short + row}
              data-testid={row === 0 ? "ovl-side-home" : "ovl-side-away"}
              className={`ovl-team-cell ovl-display${side.led ? " ovl-side-led" : ""}`}
            >
              {side.serving ? <span className="ovl-serve-dot" /> : null}
              <span className="ovl-team-name">{side.name}</span>
              <span
                data-testid={row === 0 ? "ovl-big-home" : "ovl-big-away"}
                className={`ovl-team-score${tick[row] ? " ovl-tick" : ""}`}
              >
                {side.big}
              </span>
              <span className="ovl-team-meta">{side.sub ?? ""}</span>
              {side.led ? <span data-testid="ovl-led" className="ovl-led" /> : null}
            </div>
          );
        })}
        {model.header.clock ? <div className="ovl-clock-cell ovl-display">{model.header.clock}</div> : null}
        <div className="ovl-brand ovl-display">seazn</div>
      </div>
      {model.detail.length > 0 || model.chase || model.result ? (
        <div data-testid="ovl-detail" className="ovl-detail-band">
          {model.result ? (
            <span data-testid="ovl-result" className="ovl-detail-emphasis">{model.result}</span>
          ) : model.chase ? (
            <span data-testid="ovl-chase" className="ovl-detail-emphasis">{model.chase}</span>
          ) : null}
          {model.detail.map((line, i) => (
            <span key={line + i} className="contents">
              {i > 0 || model.chase || model.result ? <span className="ovl-detail-sep" /> : null}
              <span>{line}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

  and `apps/web/src/components/overlay/overlay-bug.tsx`:

```tsx
"use client";
// Theme B — the corner bug (_THEMES.md §4), the pad's own stadium-night tile
// so the stream matches the app. `cells[].value` is always "home–away" by
// construction in `overlayModel`, so each row renders its own half of it —
// that split lives here, in the renderer, rather than widening the model.
import type { OverlayModel } from "@/lib/overlay-model";

const halfOf = (value: string, row: 0 | 1): string => {
  const parts = value.split("–");
  return parts[row] ?? value;
};

export function OverlayBug({ model, tick }: { model: OverlayModel; tick: [boolean, boolean] }) {
  return (
    <div className="ovl-bug">
      <div className="ovl-bug-header">
        {model.live ? <span data-testid="ovl-live-dot" className="ovl-live-dot" /> : null}
        <span className="ovl-bug-context">{model.header.context}</span>
        {model.header.clock ? (
          <span className="ovl-bug-brand ovl-display" style={{ color: "var(--sport-led)" }}>
            {model.header.clock}
          </span>
        ) : (
          <span className="ovl-bug-brand ovl-display">seazn</span>
        )}
      </div>
      {([0, 1] as const).map((row) => {
        const side = model.sides[row];
        return (
          <div
            key={side.short + row}
            data-testid={row === 0 ? "ovl-side-home" : "ovl-side-away"}
            className={`ovl-bug-row ovl-display${side.led ? " ovl-side-led" : ""}`}
          >
            {side.led ? <span data-testid="ovl-led" className="ovl-led" /> : null}
            <span className="ovl-bug-code">{side.short}</span>
            {side.serving ? <span className="ovl-serve-dot" /> : null}
            {model.cells.length > 0 ? (
              <span data-testid="ovl-cells" className="ovl-bug-cells">
                {model.cells.map((cell, i) => (
                  <span key={cell.key} className={i === model.cells.length - 1 ? "ovl-bug-cell-current" : undefined}>
                    {halfOf(cell.value, row)}
                  </span>
                ))}
              </span>
            ) : null}
            <span
              data-testid={row === 0 ? "ovl-big-home" : "ovl-big-away"}
              className={`ovl-bug-score${tick[row] ? " ovl-tick" : ""}`}
            >
              {side.big}
            </span>
            <span className="ovl-bug-meta">{side.sub ?? ""}</span>
          </div>
        );
      })}
      {model.result || model.chase || model.detail.length > 0 ? (
        <div data-testid="ovl-detail" className="ovl-bug-footer ovl-label">
          {model.result ? (
            <span data-testid="ovl-result" className="ovl-detail-emphasis">{model.result}</span>
          ) : model.chase ? (
            <span data-testid="ovl-chase" className="ovl-detail-emphasis">{model.chase}</span>
          ) : null}
          <span>{model.detail.join(" · ")}</span>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 10: The contrast gate is T1's — audit the ROLE table, do not write a second test (amended 2026-09-07).** `apps/web/src/components/overlay/__tests__/contrast.test.ts` exists from T1 Task 2 and sweeps `OVERLAY_PAIR_ROLES` × every sport from `SPORT_PALETTES` (`components/overlay/tokens.ts`). This step: open Step 4's `.ovl-*` CSS and Step 9's two skins and list every (foreground, background) token pair they PAINT; for each, name the `OVERLAY_PAIR_ROLES` row whose `where` covers it. A pair with no row is added to `tokens.ts` as one row (id, fg, bg, floor by rendered size — ≥ 24 px or ≥ 18.66 px bold → 3, else 4.5 — and `where` naming the class). Paste the audit table (pair → row id) into the PR inventory. Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/components/overlay --reporter=json --outputFile=/tmp/ovl-w1/t5-contrast.json` — expected: T1's counts plus one row's worth of cases per added role, and any red row recorded as a FINDING against `_THEMES.md` (never a lowered floor). Recorded weak spot: the sweep cannot see a pair the table lacks — the audit above is the killer for "paint a pair without a row", and the reviewer re-runs it.

- [ ] **Step 11: Run the unit gate — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/overlay-dict-coverage.test.ts src/components/overlay --reporter=json --outputFile=/tmp/ovl-w1/t5-green.json`
  Expected: `numFailedTests: 0`; dict coverage contributes 10 tests, contrast 45. If a contrast case reds, that is a REAL finding about `SPORT_PALETTES` on a new surface — record it for the owner and raise the floor question; do NOT lower the threshold.

- [ ] **Step 12: Drive the product, not the test.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh rebuild --label ovl`, re-read the port from `_buildManifest.js`, seed a cricket fixture and set the override row, then open `/overlay/fixtures/<id>?style=bar` in a real browser at 1920×1080. Write down, beside a pass/fail: the body is see-through over a light AND a dark frame; the score numerals are aligned; a 43-character entrant name does not wrap; the LED sits on the batting side; the live dot breathes; nothing slid in on load. Then check watch-list 7: `curl -s <base>/_next/static/css/*.css | grep -ac "Barlow"` and the browser network tab — record whether a second `@font-face` and a second woff2 download appear.

- [ ] **Step 13: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/app/overlay apps/web/src/components/overlay apps/web/src/app/globals.css apps/web/src/components/cookie-consent.tsx apps/web/src/components/__tests__/cookie-consent-overlay-segment.test.tsx apps/web/src/server/public-site/data.ts apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts apps/web/src/lib/__tests__/overlay-dict-coverage.test.ts`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(route): the transparent per-fixture page, in the sport's own colours" -m "Nested layout for the transparent ground, two server gates that both 404, one client stage scaling a native 1920x1080 canvas, and the three motions from _THEMES.md 6. Copy in four locales." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 6: The organiser panel, and the two props that reach it

**Files:**
- Create: `apps/web/src/components/v2/fixture-stream-panel.tsx`
- Create: `apps/web/src/components/v2/stream-phone-tab.tsx` (Step 3b — the Phone tab shell, D-W1-1)
- Modify: `apps/web/src/components/v2/stages-panel.tsx` — `Props` (beside `canEdit` `:205`), the destructure, `openStreamFor` from the URL, and the `<RunSheet>` mount (`:1167-1183`) — re-pinned 2026-09-07 @ fb99bbd4c: `FixtureLine` was retired by desk W2 (#725)
- Modify: `apps/web/src/components/v2/desk/run-sheet.tsx` — Props (`:44-80`) and both `<RunSheetRow>` call sites (`:261`, `:296`)
- Modify: `apps/web/src/components/v2/desk/run-sheet-row.tsx` — ONE import + ONE conditional line beside `run-sheet-edit-time` (`:377`); **desk W3 is editing this file** — rebase after any W3 merge, never race it
- Modify (Test): `apps/web/src/components/v2/desk/__tests__/run-sheet-row.test.tsx` — Step 3a's gate cases
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` — the `Promise.all` (`:124-138`) and the `<StagesPanel>` mount (`:596`)
- Modify: `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json`
- Modify (generated): `apps/web/src/lib/i18n-keys.ts`

**Interfaces:**
- Consumes: `useMsg(): (key: MessageKey, vars?) => string` (`components/i18n/dict-provider.tsx:113`); `streamUrlSchema` (Task 3); `OverlayStage` (Task 5 Step 8) and `themesForSport`, `defaultThemeFor`, `ThemeId` from `@/components/overlay/theme-registry` (Task 5 Step 6c — the panel reads the REGISTRY, so a theme registered tomorrow appears in the console with no edit to this file); `fetchLiveFixture` (`live-score-data.ts:30`); `decidedOutcomeTemplates` — NOT available client-side with a dictionary, so the panel passes a templates object built from `useMsg` (a `MsgFn`, ui keys — the same call the server makes).
- Produces:
  - `export interface FixtureStreamPanelProps { fixtureId: string; sportKey: string; homeName: string; awayName: string; homeEntrantId: string; awayEntrantId: string; initialStreamUrl: string | null; relayEntitled: boolean; defaultTab?: "obs" | "phone" }` (amended 2026-09-07)
  - `export function FixtureStreamPanel(props: FixtureStreamPanelProps): JSX.Element`
  - `export function StreamRowSlot(props: { fixture: { id: string; home_entrant_id: string | null; away_entrant_id: string | null; stream_url: string | null }; sportKey: string; relayEntitled: boolean; entrantNames: Record<string, string>; defaultOpen: boolean }): JSX.Element` — the toggle + expander the row mounts (Step 3b)
  - `export function StreamPhoneTab(props: { relayEntitled: boolean }): JSX.Element` and `export const CREDIT_PACKS = [1, 5, 20] as const` (`stream-phone-tab.tsx`, Step 3b)
  - `StagesPanel` `Props` gains `sportKey: string; streamingEntitled: boolean; relayEntitled: boolean`; `RunSheet` and `RunSheetRow` gain the same three plus `openStreamFor: string | null` (Step 4)

> **Ruling applied (owner answer 17 / Q6, 2026-09-06: "Agree"; wave prompt scope 6, over the spec):** the toggle's gate is `canEdit && streamingEntitled` and **nothing else** — in particular **NOT** the schedule toggle's `fixture.status === "scheduled"`, which sits on the very next line of the same row and is the obvious thing to copy.
>
> **Why, in the owner's terms:** the replay link is worth as much to a club as the live one, and a club attaches it AFTER the final whistle — when the fixture is `completed`, not `scheduled`. A status gate would hide the control at exactly the moment it is wanted, and there is no other surface that can set `stream_url`. The cost of keeping it open is one more button on a row, behind an entitlement no customer holds today, so the blast radius is zero.
>
> **Pinned by a test, not by this paragraph** (Step 3a below): the panel toggle is asserted present on a **decided** fixture, and absent when either half of the real gate is false. A gate that is only stated in prose is a gate nothing kills.

- [ ] **Step 3a: Pin the gate — the panel opens at EVERY status.** Add to `apps/web/src/components/v2/desk/__tests__/run-sheet-row.test.tsx` (EXISTS on `main`; re-pinned 2026-09-07 @ fb99bbd4c — `FixtureLine` was retired by desk W2, the row is `RunSheetRow`), a static-markup test over the row's gate, using that file's own render helper and fixture builder (read three neighbouring cases first). `apps/web` vitest is `environment: "node"`, so this is a render-to-markup assertion, not a click:

```ts
// Owner answer 17 (Q6): the stream toggle is gated on `canEdit &&
// streamingEntitled` ONLY. A club attaches the REPLAY link after the final
// whistle, so a `status === "scheduled"` gate — the one the schedule-edit
// button beside it uses — would hide the control exactly when it is wanted.
//
// The decided row is the case that matters: every other status would pass
// even with the wrong gate copied in, because `scheduled` is the default in
// most fixtures a test builds.
it.each(["scheduled", "in_play", "completed", "forfeit", "abandoned"])(
  "the stream toggle is present at status %s when canEdit && streamingEntitled",
  (status) => { /* render RunSheetRow with this status, canEdit: true,
                   streamingEntitled: true (the file's own helper); expect
                   `fixture-stream-toggle` in the markup */ },
);

it("is absent when the org is not entitled, at a status where it would otherwise show", () => {
  // streamingEntitled: false, status: "completed" — the NEGATIVE pair, so
  // "present at every status" cannot pass by the control being unconditional.
});

it("is absent when canEdit is false, at the same status", () => {});
```

  `run-sheet-row.test.tsx` already mounts `RunSheetRow` to markup (read its helper before writing); if a status the row's fixture type refuses is in the list above, drop that one row and record it. If the row is somehow not mountable, assert the same three facts through `stream-overlay.spec.ts` in Task 8 instead and record WHICH here — but do not drop the decided-status row: it is the whole point of the ruling.

- [ ] **Step 1: Add the panel copy in all four locales.** `apps/web/src/dictionaries/en/ui.json` (the `embed.*` block at `:419-421` is the copy-button precedent):

```json
  "stream.toggle.open": "Stream",
  "stream.toggle.close": "Close",
  "stream.title": "Stream this match",
  "stream.lead": "Put the live score inside your own broadcast. The video stays on your channel.",
  "stream.tab.bar": "Broadcast bar",
  "stream.tab.bug": "Corner bug",
  "stream.preview.label": "Preview",
  "stream.link.label": "Overlay link",
  "stream.link.copy": "Copy",
  "stream.link.copied": "Copied",
  "stream.step1": "In OBS, add a Browser source with this link at 1920 × 1080.",
  "stream.step2": "Drag it above your camera — the background is transparent.",
  "stream.step3": "Start streaming, then paste your stream link below.",
  "stream.url.label": "Stream link",
  "stream.url.hint": "YouTube, Facebook, Twitch or Kick.",
  "stream.save": "Save link",
  "stream.saved": "Saved",
  "stream.error.invalid": "Use an https link to YouTube, Facebook, Twitch or Kick.",
  "stream.error.save": "Could not save the link. Try again.",
  "stream.codeNote": "Teams show as the first three letters of their name."
```

  `fr/ui.json`:

```json
  "stream.toggle.open": "Diffusion",
  "stream.toggle.close": "Fermer",
  "stream.title": "Diffuser ce match",
  "stream.lead": "Affichez le score en direct dans votre propre diffusion. La vidéo reste sur votre chaîne.",
  "stream.tab.bar": "Bandeau",
  "stream.tab.bug": "Vignette",
  "stream.preview.label": "Aperçu",
  "stream.link.label": "Lien de l'incrustation",
  "stream.link.copy": "Copier",
  "stream.link.copied": "Copié",
  "stream.step1": "Dans OBS, ajoutez une source Navigateur avec ce lien en 1920 × 1080.",
  "stream.step2": "Placez-la au-dessus de la caméra — le fond est transparent.",
  "stream.step3": "Lancez la diffusion, puis collez le lien ci-dessous.",
  "stream.url.label": "Lien de diffusion",
  "stream.url.hint": "YouTube, Facebook, Twitch ou Kick.",
  "stream.save": "Enregistrer",
  "stream.saved": "Enregistré",
  "stream.error.invalid": "Utilisez un lien https vers YouTube, Facebook, Twitch ou Kick.",
  "stream.error.save": "Enregistrement impossible. Réessayez.",
  "stream.codeNote": "Les équipes apparaissent avec les trois premières lettres de leur nom."
```

  `es/ui.json`:

```json
  "stream.toggle.open": "Emisión",
  "stream.toggle.close": "Cerrar",
  "stream.title": "Emitir este partido",
  "stream.lead": "Muestra el marcador en directo dentro de tu propia emisión. El vídeo se queda en tu canal.",
  "stream.tab.bar": "Banda inferior",
  "stream.tab.bug": "Mosca",
  "stream.preview.label": "Vista previa",
  "stream.link.label": "Enlace de la sobreimpresión",
  "stream.link.copy": "Copiar",
  "stream.link.copied": "Copiado",
  "stream.step1": "En OBS, añade una fuente de Navegador con este enlace a 1920 × 1080.",
  "stream.step2": "Colócala encima de la cámara: el fondo es transparente.",
  "stream.step3": "Empieza a emitir y pega aquí el enlace de tu emisión.",
  "stream.url.label": "Enlace de emisión",
  "stream.url.hint": "YouTube, Facebook, Twitch o Kick.",
  "stream.save": "Guardar enlace",
  "stream.saved": "Guardado",
  "stream.error.invalid": "Usa un enlace https a YouTube, Facebook, Twitch o Kick.",
  "stream.error.save": "No se pudo guardar el enlace. Inténtalo de nuevo.",
  "stream.codeNote": "Los equipos se muestran con las tres primeras letras de su nombre."
```

  `nl/ui.json`:

```json
  "stream.toggle.open": "Stream",
  "stream.toggle.close": "Sluiten",
  "stream.title": "Deze wedstrijd streamen",
  "stream.lead": "Zet de live stand in je eigen uitzending. De video blijft op je eigen kanaal.",
  "stream.tab.bar": "Onderbalk",
  "stream.tab.bug": "Hoektegel",
  "stream.preview.label": "Voorbeeld",
  "stream.link.label": "Overlaylink",
  "stream.link.copy": "Kopiëren",
  "stream.link.copied": "Gekopieerd",
  "stream.step1": "Voeg in OBS een Browser-bron toe met deze link op 1920 × 1080.",
  "stream.step2": "Sleep hem boven je camera — de achtergrond is transparant.",
  "stream.step3": "Start de stream en plak hieronder je streamlink.",
  "stream.url.label": "Streamlink",
  "stream.url.hint": "YouTube, Facebook, Twitch of Kick.",
  "stream.save": "Link opslaan",
  "stream.saved": "Opgeslagen",
  "stream.error.invalid": "Gebruik een https-link naar YouTube, Facebook, Twitch of Kick.",
  "stream.error.save": "Opslaan is niet gelukt. Probeer het opnieuw.",
  "stream.codeNote": "Teams worden getoond met de eerste drie letters van hun naam."
```

  Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && pnpm i18n:gen-keys`.

- [ ] **Step 2: Run the dictionary gate — expect red, then green.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/overlay-dict-coverage.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t6a.json`
  Before Step 1 this reds on `finds the keys at all` (`expected +0 to be greater than or equal to 12`) once the panel exists and references them; run it AFTER the panel (Step 3) if you want the honest red. Expected after both: `numFailedTests: 0`, and `pnpm i18n:gen-keys` leaves no further diff.

- [ ] **Step 3: Write the panel.** Create `apps/web/src/components/v2/fixture-stream-panel.tsx`:

```tsx
"use client";
// "Stream this match" — the organiser's whole job, on the fixture row of the
// division's fixtures tab (R12: that tab IS the owner's "Fixture Console").
//
// Design tokens: _THEMES.md §8. Phone first (R15): one column at 320 with every
// control full width and 44 px tall; at ≥ 768 the copy button moves INSIDE the
// link field. One DOM, branched with `max-md:*` / `md:*` — never a second tree,
// and the control SET is identical at both ends.
//
// Imports `streamUrlSchema` from `@/lib/stream-url`, never from `@/server/**`
// (a client component importing @/server is a build failure).
import { useEffect, useState } from "react";
import { Video } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import { streamUrlSchema } from "@/lib/stream-url";
// The preview is the REAL stage on the endpoint's payload (amended 2026-09-07):
// same contract the overlay polls, so the console shows what OBS will show.
import { fetchOverlayFixture, type OverlayLiveData } from "@/components/public-site/live-score-data";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { OverlayStage } from "@/components/overlay/overlay-stage";
// Owner answer 18 (Q7): the tabs come FROM the registry, filtered to this
// fixture's sport. A theme registered tomorrow appears here with no edit to
// this file — which is the whole point, and is why there is no `bar`/`bug`
// literal below.
import { defaultThemeFor, themesForSport, type ThemeId } from "@/components/overlay/theme-registry";
// `MessageKey` is the generated `ui` key union. `OverlayThemeDef.labelKey` is a
// plain `string` on purpose — the registry is imported by the SERVER page too,
// and typing it as `MessageKey` would tie a route-side module to the generated
// catalogue. The one narrowing cast lives here, at the single call site, and
// the dictionary-coverage test is what proves every registered key exists.
import { messages, type MessageKey } from "@/lib/messages";

export interface FixtureStreamPanelProps {
  fixtureId: string;
  sportKey: string;
  homeEntrantId: string;
  awayEntrantId: string;
  homeName: string;
  awayName: string;
  initialStreamUrl: string | null;
}

const EMPTY: OverlayLiveData = { status: "scheduled", summary: null, outcome: null, lastSeq: null, venueTz: "UTC" };

export function FixtureStreamPanel(props: FixtureStreamPanelProps) {
  const msg = useMsg();
  // "for now apply the default one" (owner answer 18): the panel OPENS on the
  // sport's default. The organiser's choice from here is a link, not stored
  // state — the club picks a theme by which URL it pastes into OBS.
  const [style, setStyle] = useState<ThemeId>(() => defaultThemeFor(props.sportKey));
  const themes = themesForSport(props.sportKey);
  const [url, setUrl] = useState(props.initialStreamUrl ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [live, setLive] = useState<OverlayLiveData>(EMPTY);

  // The preview shows THE FIXTURE'S OWN current score, not a mock — the whole
  // point of previewing the real component. One fetch; the stage's own
  // transport keeps it moving from there.
  useEffect(() => {
    let cancelled = false;
    void fetchOverlayFixture(props.fixtureId)
      .then((data) => {
        if (!cancelled) setLive(data);
      })
      .catch(() => {
        // the preview falls back to the not-started composition
      });
    return () => {
      cancelled = true;
    };
  }, [props.fixtureId]);

  const overlayUrl =
    typeof window === "undefined"
      ? `/overlay/fixtures/${props.fixtureId}?style=${style}`
      : `${window.location.origin}/overlay/fixtures/${props.fixtureId}?style=${style}`;

  async function save() {
    setError(null);
    setSaved(false);
    const parsed = streamUrlSchema.safeParse(url);
    if (!parsed.success) {
      setError(msg("stream.error.invalid"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/fixtures/${props.fixtureId}/stream`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamUrl: parsed.data }),
      });
      const json = (await res.json()) as { ok?: boolean };
      if (!res.ok || json.ok === false) throw new Error("save failed");
      setSaved(true);
    } catch {
      setError(msg("stream.error.save"));
    } finally {
      setBusy(false);
    }
  }

  const tab = (value: ThemeId, label: string, testid: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={style === value}
      data-testid={testid}
      onClick={() => setStyle(value)}
      className={`min-h-11 rounded-md px-2.5 py-1 text-xs font-medium max-md:w-full md:min-h-0 ${
        style === value
          ? "bg-purple-100 text-purple-800"
          : "text-slate-500 hover:bg-purple-50 hover:text-purple-700"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div data-testid="stream-panel" className="card mt-2 p-5">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        <Video aria-hidden size={16} strokeWidth={1.75} className="text-purple-500" />
        {msg("stream.title")}
      </p>
      <p className="mt-1 text-xs text-slate-500">{msg("stream.lead")}</p>

      {/* One tab per REGISTERED theme that suits this sport, in registry
          order. The testid is derived from the id (`stream-tab-<id>`), so the
          e2e's `stream-tab-bar` / `stream-tab-bug` selectors are unchanged and
          a future theme gets its own without a naming decision. The label is
          `theme.labelKey` through `useMsg`, so it lands in all four locales
          and the dictionary-coverage gate finds the literal in the registry. */}
      <div role="tablist" className="mt-3 flex gap-2 max-md:flex-col">
        {themes.map((theme) =>
          tab(theme.id, msg(theme.labelKey as MessageKey), `stream-tab-${theme.id}`),
        )}
      </div>

      {/* The REAL component at 1/3 scale over a pitch-green stand-in, so the
          organiser sees exactly what OBS will composite (_THEMES.md §8). */}
      <div
        data-testid="stream-preview"
        aria-label={msg("stream.preview.label")}
        className="relative mt-3 h-24 overflow-hidden rounded-lg"
        style={{ background: "linear-gradient(180deg, #3d7a3a, #2e6a2d)" }}
      >
        <div style={{ transform: "scale(0.3333)", transformOrigin: "top left" }}>
          <OverlayStage
            fixtureId={props.fixtureId}
            initial={live}
            realtime={false}
            sportKey={props.sportKey}
            style={style}
            sides={[
              { id: props.homeEntrantId, name: props.homeName },
              { id: props.awayEntrantId, name: props.awayName },
            ]}
            startLabel={null}
            dict={messages as unknown as Record<string, string>}
            decidedTemplates={decidedOutcomeTemplates(msg)}
          />
        </div>
      </div>

      <label className="mt-4 block">
        <span className="label">{msg("stream.link.label")}</span>
        <span className="flex gap-2 max-md:flex-col md:relative">
          <input
            data-testid="stream-link"
            readOnly
            value={overlayUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="min-h-11 w-full min-w-0 rounded-lg border border-purple-100 bg-slate-950 px-3 font-mono text-[11px] text-slate-100 md:h-10 md:min-h-0 md:pr-24"
          />
          <button
            type="button"
            data-testid="stream-copy"
            onClick={() => {
              void navigator.clipboard.writeText(overlayUrl).then(() => setCopied(true));
            }}
            className="btn btn-ghost min-h-11 max-md:w-full md:absolute md:right-1 md:top-1 md:h-7 md:min-h-0 md:px-3 md:text-xs"
          >
            {copied ? msg("stream.link.copied") : msg("stream.link.copy")}
          </button>
        </span>
      </label>

      <ol data-testid="stream-steps" className="mt-4 list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-slate-700">
        <li>{msg("stream.step1")}</li>
        <li>{msg("stream.step2")}</li>
        <li>{msg("stream.step3")}</li>
      </ol>

      <label className="mt-4 block">
        <span className="label">{msg("stream.url.label")}</span>
        <input
          data-testid="stream-url-input"
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setSaved(false);
            setError(null);
          }}
          className="min-h-11 w-full rounded-lg border border-purple-200 bg-white px-3 text-[13px] text-slate-700 md:h-10 md:min-h-0"
        />
      </label>
      <p className="mt-1 text-[11px] text-slate-500">{msg("stream.url.hint")}</p>
      {error ? (
        <p data-testid="stream-error" role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        data-testid="stream-save"
        disabled={busy}
        onClick={() => void save()}
        className="btn btn-primary mt-3 min-h-11 max-md:w-full"
      >
        {saved ? msg("stream.saved") : msg("stream.save")}
      </button>
      <p className="mt-3 text-[11px] text-slate-500">{msg("stream.codeNote")}</p>
    </div>
  );
}
```

- [ ] **Step 3b (amended 2026-09-07, design §3.8 / §5.3, D-W1-1): two tabs, the Phone tab shell, and the row slot.** In `apps/web/src/components/v2/fixture-stream-panel.tsx` (Step 3's file):

  (a) Props gain `relayEntitled: boolean` and `defaultTab?: "obs" | "phone"` (default `"obs"`). Above the OBS body, a tab strip — `role="tablist"` `aria-label={msg("stream.tabs.label")}` with two `<button role="tab" aria-selected data-testid="stream-tab-obs" | "stream-tab-phone">` in the §8 style-tab classes, full-width 44 px at 320 (`max-md:flex-1 max-md:min-h-11`). The OBS body is Step 3's unchanged; the Phone body is (b).

  (b) Create `apps/web/src/components/v2/stream-phone-tab.tsx`:

```tsx
"use client";
// The Phone tab (Tier B), W1 SHELL (design §5.3; plan decision D-W1-1): the
// gate is REAL from PR1 — no `streaming.relay` → UpgradeGate; the key (an
// override, while dark) → the three credit packs rendered DISABLED with the
// "soon" line. R1 removes `disabled` and the line in the same change that adds
// POST /api/billing/relay-checkout. Nothing here posts anywhere in W1.
import { useMsg } from "@/components/i18n/dict-provider";
import { UpgradeGate } from "@/components/upgrade-gate";

export const CREDIT_PACKS = [1, 5, 20] as const;

export function StreamPhoneTab({ relayEntitled }: { relayEntitled: boolean }) {
  const msg = useMsg();
  if (!relayEntitled) {
    // RE-PIN `UpgradeGate`'s props at `components/upgrade-gate.tsx:252-330`
    // (featureKey + the plan href it derives, or `href` if it needs one);
    // pass `featureKey="streaming.relay"` and nothing invented.
    return <UpgradeGate featureKey="streaming.relay" />;
  }
  return (
    <div data-testid="stream-phone-buy" className="flex flex-col gap-3">
      <p className="text-sm font-semibold text-slate-700">{msg("stream.phone.buyTitle")}</p>
      <p className="text-xs text-slate-500">{msg("stream.phone.buyExplainer")}</p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {CREDIT_PACKS.map((n) => (
          <button
            key={n}
            type="button"
            disabled
            aria-disabled="true"
            data-testid={`stream-pack-${n}`}
            className="min-h-11 rounded-lg border border-purple-200 p-3 text-left disabled:opacity-60"
          >
            <span className="block text-lg font-semibold text-slate-800">{msg("stream.phone.pack", { n })}</span>
            <span className="block text-[11px] text-slate-500">{msg("stream.phone.soon")}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

  Dictionary keys (four locales, `ui.json`, beside Step 1's `stream.*`): `stream.tabs.label` "Streaming", `stream.tabs.obs` "OBS overlay", `stream.tabs.phone` "Phone stream", `stream.phone.buyTitle` "Buy match credits", `stream.phone.buyExplainer` "1 match = 1 credit, up to 5 hours of streaming from a phone.", `stream.phone.pack` "{n} credit(s)" (RE-PIN the plural form the dictionaries use), `stream.phone.soon` "Available soon". Then `pnpm i18n:gen-keys`; the Step 1 coverage test proves every key exists in all four.

  (c) The ROW SLOT — the one thing `run-sheet-row.tsx` mounts. In `fixture-stream-panel.tsx`, export:

```tsx
/** Toggle + expander for one run-sheet row: the ONE import and ONE
 *  conditional line the row gets (R11). `defaultOpen` is how `?stream=<id>`
 *  (Step 4) and R1's Stripe `success_url` land on the open panel. */
export function StreamRowSlot(props: {
  fixture: { id: string; home_entrant_id: string | null; away_entrant_id: string | null; stream_url: string | null };
  sportKey: string;
  relayEntitled: boolean;
  entrantNames: Record<string, string>;
  defaultOpen: boolean;
}) {
  const msg = useMsg();
  const [open, setOpen] = useState(props.defaultOpen);
  return (
    <>
      <button
        type="button"
        data-testid="fixture-stream-toggle"
        aria-expanded={open}
        aria-label={msg("stream.toggle")}
        title={msg("stream.toggle")}
        onClick={() => setOpen((o) => !o)}
        className="-my-1 flex min-h-11 w-11 shrink-0 items-center justify-center text-slate-500 hover:text-purple-700"
      >
        <Video size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {open ? (
        <div data-testid="fixture-stream-panel" className="basis-full">
          <FixtureStreamPanel
            fixtureId={props.fixture.id}
            sportKey={props.sportKey}
            homeName={props.fixture.home_entrant_id ? (props.entrantNames[props.fixture.home_entrant_id] ?? "—") : "—"}
            awayName={props.fixture.away_entrant_id ? (props.entrantNames[props.fixture.away_entrant_id] ?? "—") : "—"}
            homeEntrantId={props.fixture.home_entrant_id ?? "home"}
            awayEntrantId={props.fixture.away_entrant_id ?? "away"}
            initialStreamUrl={props.fixture.stream_url}
            relayEntitled={props.relayEntitled}
            defaultTab={props.defaultOpen ? "obs" : "obs"}
          />
        </div>
      ) : null}
    </>
  );
}
```

  RE-PIN: `RunSheetFixture` (`lib/run-sheet-groups.ts`) must carry `stream_url` — Task 3 Step 8 widened `PublicFixture`; if the run-sheet's fixture type is a different projection, add `stream_url: string | null` to it at the ONE place it is built (`toRunSheetFixture`, `stages-panel.tsx:1168`) and record which. `basis-full` puts the expander on its own line under the row in the row's flex-wrap (read the row's root classes at `:330-360` — if the row is not `flex-wrap`, wrap the slot's expander in the row's existing "details" region instead and record it).

- [ ] **Step 4: Thread the props (amended 2026-09-07 @ fb99bbd4c — `FixtureLine` is retired; the run sheet is `stages-panel.tsx` → `run-sheet.tsx` → `run-sheet-row.tsx`).**

  (a) `apps/web/src/components/v2/stages-panel.tsx` — `Props` (beside `canEdit: boolean;` at `:205`):

```ts
  /** The division's sport — the stream panel themes its preview with it.
   *  This panel had no sport key before (stream overlay W1). */
  sportKey: string;
  /** `hasFeature(orgId, "streaming.overlay")` resolved server-side by the
   *  division page (the client never decides). False hides the toggle. */
  streamingEntitled: boolean;
  /** `hasFeature(orgId, "streaming.relay")` — the Phone tab's body
   *  (UpgradeGate vs the credit packs); never the toggle. */
  relayEntitled: boolean;
```

  the destructure gains the three names; and the `<RunSheet>` mount (`:1167-1183`) gains

```tsx
        sportKey={sportKey}
        streamingEntitled={streamingEntitled}
        relayEntitled={relayEntitled}
        openStreamFor={openStreamFor}
```

  where `openStreamFor` is read ONCE beside the existing `filter` state: `const openStreamFor = useSearchParams().get("stream");` (`stages-panel.tsx` is a client component — it holds `setFilter`; RE-PIN by reading its first line for `"use client"`, and if the tab reads its URL state through a prop from the page instead, thread `stream` the way `tab` arrives).

  (b) `apps/web/src/components/v2/desk/run-sheet.tsx` — Props (`:44-80`) gain the same three plus `openStreamFor: string | null`; BOTH `<RunSheetRow>` call sites (`:261`, `:296`) pass them through.

  (c) `apps/web/src/components/v2/desk/run-sheet-row.tsx` — the ONE import `import { StreamRowSlot } from "@/components/v2/fixture-stream-panel";`, the four props on the row's prop type (`sportKey: string; streamingEntitled: boolean; relayEntitled: boolean; openStreamFor: string | null;`), and the ONE conditional line immediately AFTER the `canEditFixtureTime(...) ? <button data-testid="run-sheet-edit-time" …> : <span …>` expression (`:365-392`; RE-PIN the closing of that ternary and place this as its next sibling):

```tsx
          {canEdit && streamingEntitled ? (
            <StreamRowSlot fixture={fixture} sportKey={sportKey} relayEntitled={relayEntitled} entrantNames={entrantNames} defaultOpen={openStreamFor === fixture.id} />
          ) : null}
```

  Gate = `canEdit && streamingEntitled` and NOTHING else — not the edit-time predicate on the line above (owner answer 17 / Q6: the toggle opens at every status; a club attaches the replay link after the whistle). Step 3a's test pins it on a decided row.

- [ ] **Step 5: Feed the props from the division page.** In `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx`, add one entry to the `Promise.all` (`:124-138`) — after `hasFeature(auth.orgId, "exports")`:

```ts
    // Stream overlay W1 (R1): resolved here, server-side, exactly as
    // `embeds.enabled` is at :814 — the panel is absent when false, and the
    // client is told rather than asked to derive it. `streaming.relay` (Task 4,
    // design §5.1/§5.3) drives the Phone tab's body — UpgradeGate or the
    // (W1-disabled) buy card — never the toggle.
    hasFeature(auth.orgId, "streaming.overlay"),
    hasFeature(auth.orgId, "streaming.relay"),
```

  widen the destructure to `const [competition, stages, fixtures, entrants, scheduleSettings, canExport, streamingEntitled, venues] = await Promise.all([…]);` (matching the array's new order — put the new call immediately before `listVenues` so both lists stay aligned), and on the `<StagesPanel …>` mount (`:596`) add:

```tsx
            sportKey={division.sport_key}
            streamingEntitled={streamingEntitled}
            relayEntitled={relayEntitled}
```

  (the destructure gains `relayEntitled` after `streamingEntitled`, matching the array order; re-pinned 2026-09-07 @ fb99bbd4c: the `Promise.all` is at `:126-138` and the `embeds.enabled` precedent at `:814`.)

- [ ] **Step 6: Run the console's own suites — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/components/v2/__tests__ src/lib/__tests__/overlay-dict-coverage.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t6b.json`
  Expected: `numFailedTests: 0`. Hand-built `StagesPanel` props in that directory will fail to type-check on the two new REQUIRED props — add them there rather than making the props optional; an optional entitlement prop defaults to a state the server never chose.

- [ ] **Step 7: `tsc` — the only thing that can see the prop threading.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npx tsc --noEmit -p apps/web/tsconfig.json; echo "EXIT=$?"`
  Expected: `EXIT=0`. `rtk` prints "tsc clean" while tsc exits 1 — read the `EXIT=` line, not the wrapper's verdict. A local `next build` skips typecheck entirely and proves nothing here.

- [ ] **Step 8: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/components/v2/fixture-stream-panel.tsx apps/web/src/components/v2/stages-panel.tsx "apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx" apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(console): Stream this match on the fixture row" -m "Style tabs over a preview that is the real OverlayStage on the fixture's own score, the overlay link with copy, three numbered steps and the stream-link save. One import and one conditional line in stages-panel.tsx (R11); sportKey and streamingEntitled threaded from the division page." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 7: The public match page link

**Files:**
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx` — insert above the `<LiveScore>` mount (`:175-182`)

**Interfaces:**
- Consumes: `fixture.stream_url: string | null` (Task 3), `fixture.status: string`, `getDictionary(locale, "public")` + `t(dict, key)` — the page already resolves `org.default_locale` and holds a `msgFn` for the `ui` namespace (`:23-24`), so the two `public.overlay.*` labels need the `public` dict, loaded the same way `news/[postSlug]/page.tsx:62` does.
- Produces: no exported symbol; one `<a data-testid="public-stream-link">`.

- [ ] **Step 1: Write the failing e2e assertion (the unit layer cannot see this).** Append to `apps/web/e2e/walkthrough/stream-overlay.spec.ts` (created in Task 8's Step 1 — do Task 8 Step 1 first, or write this block into the file as you create it):

```ts
  test("the public match page carries the saved link, and says Replay once decided", async ({ page, request }) => {
    const saved = "https://www.twitch.tv/seaznclub";
    expect((await apiJson(request, `/api/v1/fixtures/${rig.fixtureId}/stream`, "PUT", { streamUrl: saved })).status)
      .toBeLessThan(400);

    const anon = await browserContextAnonymous();
    const publicPage = await anon.newPage();
    await publicPage.goto(rig.publicFixturePath);
    const link = publicPage.getByTestId("public-stream-link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", saved);
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link, "in play or scheduled reads Watch live").toHaveText("Watch live");

    // Decide it through the real door, then reload — this page is ISR + a
    // client transport that polls the SCORE, not the link, so the label is a
    // server render. Recorded as a W1→spectator hand-off rather than pretended.
    await decideFixture(request, rig.fixtureId);
    await publicPage.reload();
    await expect(publicPage.getByTestId("public-stream-link")).toHaveText("Replay");
    await anon.close();
  });
```

> **Recorded hand-off (the wave prompt asks for this decision explicitly):** the "Watch live" → "Replay" flip cannot happen without a reload on the current page. `LiveScore` owns the only live-updating region and its `LiveFixtureData` carries `status/summary/outcome` — not `stream_url` — so the label is a server render. Widening the client payload for a label is spectator W1's composition work (spec §7 already says that programme moves this link into its court header). The test reloads and says so.

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/walkthrough/stream-overlay.spec.ts --project=walkthrough -x`
  Expected red: `Error: expect(locator).toBeVisible() failed … waiting for getByTestId('public-stream-link')` — the anchor does not exist yet.

- [ ] **Step 3: Render the link.** In the public fixture page, add to the imports `import { getDictionary, t } from "@/lib/i18n";`, resolve the dict beside the existing locale work (`const publicDict = await getDictionary(locale, "public");`), and insert immediately above the `<LiveScore …>` mount (`:175`):

```tsx
      {/* The club's own broadcast (stream overlay W1). Placement only —
          spectator W1 owns this page's composition and moves the link into its
          court header (spec §7); do not build a header here.
          `rel="noopener"` is not optional: the href is organiser-supplied, and
          `target="_blank"` without it hands the opened tab a `window.opener`
          handle to this page. The host is already restricted to the eleven-name
          allowlist server-side (R16 + owner answer 16); this is the second,
          independent guard. */}
      {fixture.stream_url ? (
        <p className="mb-4">
          <a
            data-testid="public-stream-link"
            href={fixture.stream_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 font-display text-sm font-semibold uppercase tracking-wide text-white no-underline shadow transition hover:opacity-90"
          >
            {fixture.status === "decided" || fixture.status === "finalized"
              ? t(publicDict, "overlay.replay")
              : t(publicDict, "overlay.watchLive")}
          </a>
        </p>
      ) : null}
```

- [ ] **Step 4: Run — expect PASS.** Re-run Step 2's command. Expected: that test green. Also confirm the negative pair by hand once: a fixture with no saved link renders NO `public-stream-link` node at all (`await expect(page.getByTestId("public-stream-link")).toHaveCount(0)`), which Task 8's spec asserts.

- [ ] **Step 5: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx"`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(public): Watch live / Replay on the match page" -m "One anchor under the headline, target=_blank rel=noopener, labelled by fixture status. Placement only — spectator W1 owns this page's composition (spec 7)." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 8: e2e, smoke, the visual gate, and the index

> **Ordering note:** Step 1 below creates `stream-overlay.spec.ts`, which Task 7's steps append to. If Tasks 6–7 run in one lane, do Step 1 first and let Task 7 write its own `test(...)` into the file.

**Files:**
- Create: `apps/web/e2e/walkthrough/stream-overlay.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` — `WALKTHROUGH_SPECS` gains `"stream-overlay.spec.ts"` under a `// Streaming — the OBS overlay, end to end.` comment (re-pinned 2026-09-07 @ fb99bbd4c: the list EXISTS; edited HERE, in Step 1's commit, not post-rebase)
- Modify: `apps/web/e2e/visual/seeds.ts` — ONE seed kind, `overlay-fixture` (Step 8a)
- Modify: `apps/web/e2e/visual/manifest.json` — the `overlay` and `console-panel` groups (Step 8b)
- Modify: `scripts/smoke.ts` — a new `streamOverlaySuite`, called beside `scorePadV2AppendSuite` (`:784`)
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`

**Interfaces:**
- Consumes: `apiJson(request, path, method, body?)` (`e2e/helpers.ts:128`), `activeOrg(page)` (`:1268`), `addEntrantsViaApi` (`:1412`), `createStageAndGenerate` (`:1429`), `setBoolEntitlementOverrideSql(orgId, featureKey, value)` (`:500`), `invalidateOrgEntitlements(request, orgId)` (`:943`), `expectNoHorizontalScroll(page, opts?)` (`:49`); `check(label, cond)` and `insertEntitlementOverride(owner, orgId, featureKey, value)` (`scripts/smoke.ts:91`, `:9461`), `html(s, path)` (`:12644`), `v1`/`v1data`.
- Produces: no exported symbol; one Playwright spec, one capture spec, one smoke suite.

> **R9, re-pinned 2026-09-07 @ fb99bbd4c:** the branch is rebased on `main`, and `WALKTHROUGH_SPECS` (`apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts:16`) EXISTS. The `walkthrough` project matches by PATH (`apps/web/playwright.config.ts:119`, `const WALKTHROUGH = /[\\/]e2e[\\/]walkthrough[\\/]/`), so the spec is collected with no list — but `e2e-ci-wiring.test.ts` reds in every CI job for a walkthrough spec not NAMED there. Register `stream-overlay.spec.ts` in Step 1's own commit. The visual gate is no longer a walkthrough spec (it is T1b's manifest, Step 8), so only ONE name is added.

- [ ] **Step 1: Write the failing e2e.** Create `apps/web/e2e/walkthrough/stream-overlay.spec.ts`:

```ts
// Stream overlay W1, end to end. Under e2e/walkthrough/ so the `walkthrough`
// project collects it by path (playwright.config.ts:119) — see R9 about
// WALKTHROUGH_SPECS after the rebase.
//
// The entitlement is lifted by SQL upsert (helpers.ts:500) and thawed to FALSE
// in afterAll, never deleted: the helper is an upsert with no delete, and a
// test.setTimeout would skip a `finally` anyway.
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  activeOrg,
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  expectNoHorizontalScroll,
  invalidateOrgEntitlements,
  setBoolEntitlementOverrideSql,
} from "../helpers";
import { POLL_MS } from "../../src/components/public-site/use-live-fixture";

const TAG = `ovl${Math.random().toString(36).slice(2, 7)}`;
const KEY = "streaming.overlay";

// Budget expressed in the constant it depends on, never a flat literal: if
// POLL_MS moves, the budget moves with it (a blown budget reports itself as a
// data defect, "Expected 15 / Received 14", above the timeout line).
const LIVE_BUDGET_MS = Math.max(20_000, POLL_MS * 2 + 5_000);

interface Rig {
  orgId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  divisionId: string;
  fixtureId: string;
  publicFixturePath: string;
  homeId: string;
}

/** A started CRICKET fixture with one ball bowled — short on purpose (a full
 *  T20 through the API is ~9 minutes) and cricket because R2 makes it the one
 *  sport whose default style is the bar. `cricket.toss` MUST precede
 *  `core.start` or the append is 422 WRONG_PHASE. */
async function cricketRig(page: Page, request: APIRequestContext, label: string): Promise<Rig> {
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Overlay ${label} ${TAG}`, visibility: "public", ends_on: "2030-12-31",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
    { name: "Open", sport_key: "cricket", variant_key: "t20", config: {} },
  );
  const entrants = await addEntrantsViaApi(request, div.data!.id, [
    "Milton Keynes Rovers Cricket Club First XI",
    "Northbridge Athletic",
  ]);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect(fixtureIds.length, "two entrants, one league fixture — anything else and every assertion below moves").toBe(1);
  const fixtureId = fixtureIds[0]!;
  expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBe(200);

  const toss = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0, type: "cricket.toss", payload: { winner: "home", decision: "bat" },
  });
  expect(toss.status, "cricket.toss must precede core.start — 422 WRONG_PHASE otherwise").toBeLessThan(400);
  const start = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 1, type: "core.start", payload: {},
  });
  expect(start.status).toBeLessThan(400);
  const ball = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 2, type: "cricket.ball",
    payload: { over: 0, ballInOver: 1, striker: `${entrants[0]}-p1`, nonStriker: `${entrants[0]}-p2`, bowler: `${entrants[1]}-p1`, runs: { bat: 4 } },
  });
  expect(ball.status, "one ball, so the overlay has a real number to show").toBeLessThan(400);

  return {
    orgId: org.id, orgSlug: org.slug, compSlug: comp.data!.slug, divSlug: div.data!.slug,
    divisionId: div.data!.id, fixtureId, homeId: entrants[0]!,
    publicFixturePath: `/shared/${org.slug}/${comp.data!.slug}/${div.data!.slug}/fixtures/${fixtureId}`,
  };
}

test.describe("stream overlay", () => {
  let rig: Rig;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    rig = await cricketRig(page, page.request, "W1");
    await context.close();
  });

  test.afterAll(async ({ request }) => {
    // Thaw. Never in a `finally` — a blown test budget skips those.
    await setBoolEntitlementOverrideSql(rig.orgId, KEY, false);
    await invalidateOrgEntitlements(request, rig.orgId);
  });

  test("the entitlement gate opens and closes the route, in both directions", async ({ page, request }) => {
    await setBoolEntitlementOverrideSql(rig.orgId, KEY, false);
    await invalidateOrgEntitlements(request, rig.orgId);
    const closed = await page.goto(`/overlay/fixtures/${rig.fixtureId}`);
    expect(closed?.status(), "not entitled is 404 — indistinguishable from missing, never an upsell").toBe(404);

    await setBoolEntitlementOverrideSql(rig.orgId, KEY, true);
    await invalidateOrgEntitlements(request, rig.orgId);
    const open = await page.goto(`/overlay/fixtures/${rig.fixtureId}`);
    expect(open?.status(), "the override row is the only thing that changed").toBe(200);

    const missing = await page.goto("/overlay/fixtures/00000000-0000-0000-0000-000000000000");
    expect(missing?.status()).toBe(404);
  });

  test("the page is transparent, carries the seeded score, and is themed", async ({ browser, request }) => {
    await setBoolEntitlementOverrideSql(rig.orgId, KEY, true);
    await invalidateOrgEntitlements(request, rig.orgId);

    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await anon.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
    await expect(page.getByTestId("ovl-root")).toBeVisible();

    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg, "OBS composites what is painted — an opaque body would black out the camera").toBe("rgba(0, 0, 0, 0)");

    // The score the ENDPOINT reports, not one typed here.
    const { data } = await apiJson<{ summary: { perSide: { line: string }[] } }>(
      request, `/api/v1/public/fixtures/${rig.fixtureId}`,
    );
    const expected = data!.summary.perSide[0]!.line.split(" ")[0]!;
    await expect(page.getByTestId("ovl-big-home")).toHaveText(expected);

    const board = await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-testid="ovl-root"]')!).getPropertyValue("--sport-board").trim(),
    );
    expect(board, "cricket overrides nothing, so it resolves to the :root default").toBeTruthy();
    await expect(page.getByTestId("ovl-root")).toHaveAttribute("data-style", "bar");
    await expect(page.getByTestId("ovl-live-dot")).toBeVisible();
    await anon.close();
  });

  test("a new event changes the score in place, ticks only the side that moved, and never navigates", async ({
    browser,
    request,
  }) => {
    test.setTimeout(LIVE_BUDGET_MS + 30_000);
    await setBoolEntitlementOverrideSql(rig.orgId, KEY, true);
    await invalidateOrgEntitlements(request, rig.orgId);

    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await anon.newPage();
    let navigations = 0;
    page.on("framenavigated", () => { navigations += 1; });
    await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
    const before = (await page.getByTestId("ovl-big-home").textContent()) ?? "";
    const awayBefore = (await page.getByTestId("ovl-big-away").textContent()) ?? "";
    const navBaseline = navigations;

    const scored = await apiJson(request, `/api/v1/fixtures/${rig.fixtureId}/events`, "POST", {
      expected_seq: 3, type: "cricket.ball",
      payload: { over: 0, ballInOver: 2, striker: `${rig.homeId}-p1`, nonStriker: `${rig.homeId}-p2`, bowler: "A-p1", runs: { bat: 6 } },
    });
    expect(scored.status, "the append must land — this test is meaningless otherwise").toBeLessThan(400);

    await expect
      .poll(async () => (await page.getByTestId("ovl-big-home").textContent()) ?? "", { timeout: LIVE_BUDGET_MS })
      .not.toBe(before);
    expect(navigations, "the score changed without a navigation").toBe(navBaseline);

    // Mutant (f): with the ovl-tick class application removed this line reds.
    await expect(page.getByTestId("ovl-big-home")).toHaveClass(/ovl-tick/);
    await expect(page.getByTestId("ovl-big-away"), "the side that did not move must not move").not.toHaveClass(/ovl-tick/);
    await expect(page.getByTestId("ovl-big-away")).toHaveText(awayBefore);

    // The LED sits on the batting side.
    await expect(page.getByTestId("ovl-root")).toHaveAttribute("data-led", "home");
    await anon.close();
  });

  test("style and language come from the URL, and an unknown style falls to the sport default", async ({ browser }) => {
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await anon.newPage();

    await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=bug`);
    await expect(page.getByTestId("ovl-root")).toHaveAttribute("data-style", "bug");
    // An id that is not a registry key. It must render the sport's default —
    // 200, not 404, and not a stack trace: `resolveTheme` never throws
    // (owner answer 18 / Q7), because an OBS browser source cannot be asked to
    // fix a typo mid-match. This is the only place the no-throw guarantee is
    // proven END TO END rather than in a unit; the unit cannot see the route.
    const res = await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=carousel`);
    expect(res?.status(), "an unknown style is served, never refused").toBe(200);
    await expect(page.getByTestId("ovl-root"), "cricket's default is the bar (R2)").toHaveAttribute("data-style", "bar");
    await anon.close();
  });

  for (const width of [320, 768, 1280]) {
    test(`the console panel opens and stays within the page at ${width}`, async ({ page, request }) => {
      await setBoolEntitlementOverrideSql(rig.orgId, KEY, true);
      await invalidateOrgEntitlements(request, rig.orgId);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/o/${rig.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}?tab=fixtures`);

      const toggle = page.getByTestId("fixture-stream-toggle").first();
      await expect(toggle, "attached, not visible — a folded control is not visible").toBeAttached();
      await toggle.click();
      await expect(page.getByTestId("stream-panel").first()).toBeAttached();

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="stream-panel"] [data-testid]')).map(
          (el) => el.getAttribute("data-testid")!,
        ),
      );
      expect(ids, `control set at ${width}`).toEqual([
        "stream-tab-bar", "stream-tab-bug", "stream-preview", "ovl-root", "ovl-side-home",
        "ovl-big-home", "ovl-side-away", "ovl-big-away", "ovl-moment-slot",
        "stream-link", "stream-copy", "stream-steps", "stream-url-input", "stream-save",
      ]);

      if (width === 320) {
        for (const id of ["stream-tab-bar", "stream-tab-bug", "stream-link", "stream-copy", "stream-url-input", "stream-save"]) {
          const box = await page.getByTestId(id).first().boundingBox();
          expect(box, id).not.toBeNull();
          expect(box!.height, `${id} tap target at 320`).toBeGreaterThanOrEqual(44);
        }
      }
      await expectNoHorizontalScroll(page);
    });
  }

  test("the panel saves a valid link and refuses an invalid one without sending it", async ({ page, request }) => {
    await setBoolEntitlementOverrideSql(rig.orgId, KEY, true);
    await invalidateOrgEntitlements(request, rig.orgId);
    await page.setViewportSize({ width: 1280, height: 900 });

    let puts = 0;
    await page.route(`**/api/v1/fixtures/${rig.fixtureId}/stream`, (route) => { puts += 1; return route.fallback(); });

    await page.goto(`/o/${rig.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}?tab=fixtures`);
    await page.getByTestId("fixture-stream-toggle").first().click();

    await page.getByTestId("stream-url-input").fill("https://www.youtube.com/watch?v=abc123");
    await page.getByTestId("stream-save").click();
    await expect(page.getByTestId("stream-save")).toHaveText("Saved");
    const afterValid = puts;

    await page.getByTestId("stream-url-input").fill("https://evil.example/www.youtube.com");
    await page.getByTestId("stream-save").click();
    await expect(page.getByTestId("stream-error")).toBeVisible();
    expect(puts, "an invalid host is refused in the panel and never sent").toBe(afterValid);

    const { data } = await apiJson<{ stream_url: string | null }>(request, `/api/v1/public/fixtures/${rig.fixtureId}`);
    expect(data!.stream_url, "the refused save left the saved link alone").toBe("https://www.youtube.com/watch?v=abc123");
  });

  test("a non-entitled org sees no stream toggle at all, and still sees the schedule one", async ({ page, request }) => {
    await setBoolEntitlementOverrideSql(rig.orgId, KEY, false);
    await invalidateOrgEntitlements(request, rig.orgId);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/o/${rig.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}?tab=fixtures`);
    await expect(page.getByTestId("fixture-stream-toggle")).toHaveCount(0);
    await expect(
      page.getByTestId("fixture-schedule-toggle").first(),
      "the positive pair: the row still renders its other controls, so the absence above is the gate, not a broken page",
    ).toBeAttached();
  });
});
```

  Add the two helpers this file calls and Task 7's block needs — `browserContextAnonymous` is `browser.newContext({ storageState: { cookies: [], origins: [] } })` inline above; `decideFixture(request, fixtureId)` posts `core.finalize` or the sport's decider through `apiJson` and asserts `< 400` (re-pin the exact event against `_rig.ts`'s cricket helper at execution time).

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/walkthrough/stream-overlay.spec.ts --project=walkthrough --list`
  Expected first: the spec is COLLECTED — `--list` names all eight tests under `[walkthrough]`. A spec the runner does not resolve is the silent failure R9 exists for. Then run it for real; before Task 5/6 land it reds on `ovl-root` / `fixture-stream-toggle` not existing.

- [ ] **Step 2a (amended 2026-09-07 — Task 0 Step 14's staged assertions): the overlay endpoint on the wire.** Append to `stream-overlay.spec.ts`, inside the same `describe`, after the seed helpers (the cricket rig Step 1 builds is reused; the football fixture is seeded the same way with `sport_key: "football"`):

```ts
  test("the overlay endpoint carries the public summary plus the folded-state facts, and is public exactly as the fixture JSON is", async ({ request, page }) => {
    const pub = await apiJson<{ status: string; summary: unknown; outcome: unknown }>(request, `/api/v1/public/fixtures/${cricketFixtureId}`);
    const ovl = await apiJson<{
      status: string; summary: unknown; outcome: unknown; lastSeq: number | null; venueTz: string;
      clock?: { phase: string; anchorSeconds: number; anchorAtWallMs: number };
      cricket?: { innings: { runs: number; wickets: number; legalBalls: number; ballsLimit: number | null }[] };
    }>(request, `/api/v1/public/fixtures/${cricketFixtureId}/overlay`);
    expect(ovl.status).toBe(200);
    // One authority: the SAME match_states row, byte-equal on the three shared fields.
    expect({ status: ovl.data!.status, summary: ovl.data!.summary, outcome: ovl.data!.outcome }).toEqual({ status: pub.data!.status, summary: pub.data!.summary, outcome: pub.data!.outcome });
    expect(typeof ovl.data!.lastSeq).toBe("number");
    expect(() => new Intl.DateTimeFormat("en", { timeZone: ovl.data!.venueTz }), "venueTz is a real IANA zone").not.toThrow();
    // Cricket: the innings numbers, off the folded state; the quota is the
    // T20 format's, read from the division's config rather than typed here.
    const cfg = await apiJson<{ config: { ballsPerInnings?: number } }>(request, `/api/v1/divisions/${cricketDivisionId}`);
    expect(ovl.data!.cricket, "cricket carries innings").toBeDefined();
    expect(ovl.data!.cricket!.innings[0]!.ballsLimit).toBe(cfg.data!.config.ballsPerInnings ?? 120);
    expect(ovl.data!.clock, "cricket has no period clock").toBeUndefined();

    // Football: a stamped goal in H1 anchors the clock at the stamp.
    const fb = await seedFootballFixture(request); // same rig as the cricket seed, sport_key "football"
    const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fb.fixtureId}/state`);
    const goal = await apiJson(request, `/api/v1/fixtures/${fb.fixtureId}/events`, "POST", {
      expected_seq: state.data!.last_seq, type: "football.goal", payload: { by: "home", at: { period: "H1", elapsed: 761 } },
    });
    expect(goal.status, "the goal appended").toBe(201);
    const fbOvl = await apiJson<{ clock?: { phase: string; anchorSeconds: number; anchorAtWallMs: number } }>(request, `/api/v1/public/fixtures/${fb.fixtureId}/overlay`);
    expect(fbOvl.data!.clock).toMatchObject({ phase: "H1", anchorSeconds: 761 });
    expect(fbOvl.data!.clock!.anchorAtWallMs).toBeGreaterThan(Date.now() - 60_000);
    // Period change: the stamp names a phase the match has left → no clock
    // (mutant i's wire-level killer). RE-PIN the event name/payload against
    // football.ts's schema before running.
    const s2 = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fb.fixtureId}/state`);
    await apiJson(request, `/api/v1/fixtures/${fb.fixtureId}/events`, "POST", { expected_seq: s2.data!.last_seq, type: "football.period", payload: { to: "HT", at: { period: "H1", elapsed: 2700 } } });
    const ht = await apiJson<{ clock?: unknown }>(request, `/api/v1/public/fixtures/${fb.fixtureId}/overlay`);
    expect(ht.data!.clock, "at half-time the endpoint omits the clock; the stage holds").toBeUndefined();

    // The gate is the PAGE's, not the endpoint's: thaw the org and the JSON still answers.
    const org = await activeOrg(page);
    await setBoolEntitlementOverrideSql(org.id, "streaming.overlay", false);
    await invalidateOrgEntitlements(request, org.id);
    const stillPublic = await apiJson(request, `/api/v1/public/fixtures/${cricketFixtureId}/overlay`);
    expect(stillPublic.status, "public JSON is public; the overlay PAGE 404s").toBe(200);
    await setBoolEntitlementOverrideSql(org.id, "streaming.overlay", true);
    await invalidateOrgEntitlements(request, org.id);

    // A private competition's fixture: 404, indistinguishable from missing.
    const priv = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { name: `Private ${TAG}`, visibility: "private", ends_on: "2030-12-31" });
    const pdiv = await apiJson<{ id: string }>(request, `/api/v1/competitions/${priv.data!.id}/divisions`, "POST", { name: "p", sport_key: "generic", variant_key: "", config: {} });
    await addEntrantsViaApi(request, pdiv.data!.id, ["A", "B"]);
    const { fixtureIds } = await createStageAndGenerate(request, pdiv.data!.id, { kind: "league", name: "L" });
    const hidden = await apiJson(request, `/api/v1/public/fixtures/${fixtureIds[0]}/overlay`);
    expect(hidden.status).toBe(404);
  });
```

  RE-PIN: the cricket rig's variable names (`cricketFixtureId`, `cricketDivisionId`) are Step 1's — use its names; `seedFootballFixture` is a five-line clone of the cricket seed with `sport_key: "football"`, written beside it; `TAG` from `../helpers`. Run whole-file (never `-g`).

- [ ] **Step 3: Run it green, whole-file, after Tasks 5–7.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/walkthrough/stream-overlay.spec.ts --project=walkthrough --reporter=line`
  Expected: `8 passed`. Never `-g` a slice of it — a `-g` sweep is a filename sweep in costume and will select neither of the tests a UI change most often breaks.

- [ ] **Step 4: Mutation checks (e) and (f) at the e2e layer.**
  (e) Delete the `if (!(await hasFeature(…))) notFound();` line in `page.tsx`, re-run Step 3. Expected red: `the entitlement gate opens and closes the route, in both directions` — `expected 200 to be 404`. Restore.
  (f) Remove ` ovl-tick` from the `className` template in `overlay-bar.tsx`, re-run Step 3. Expected red: `a new event changes the score in place…` — `expect(locator).toHaveClass(/ovl-tick/) failed`. Restore and re-run to green.

- [ ] **Step 5: Run the WHOLE `mobile.spec.ts` at all seven widths.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/mobile.spec.ts --reporter=line`
  Expected: no new failures against main's counts. `mobile.spec.ts` is `describe.configure({ mode: "serial" })`, so a red count there is a FLOOR, not a total — re-run after each fix until a full pass completes. The fixtures-tab cases at `:578,2715,2907,3096,3189` are the ones that will see the new toggle.

- [ ] **Step 6: Add the smoke suite.** In `scripts/smoke.ts`, add the function beside `scorePadV2AppendSuite` and call it from the same block (`:784`):

```ts
/**
 * Stream overlay W1 (spec §"Tests"). Three claims, driven through the real
 * doors, because `apiV1` prepends nothing and a route can 404 with the whole
 * unit suite green:
 *   1. the overlay page is 404 for an org with no override row (the DEFAULT
 *      state — no lever needed, which is what makes it the honest negative);
 *   2. it is 200 and carries `ovl-root` once the row is written;
 *   3. `PUT /stream` accepts an allowlisted link and `GET /api/v1/public/
 *      fixtures/{id}` hands the same string back — the seam end to end, in the
 *      one place that would catch `stream_url` being read everywhere and
 *      written nowhere.
 */
async function streamOverlaySuite(admin: Session, proOrgId: string): Promise<void> {
  admin.cookies["seazn_org"] = proOrgId;
  const comp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31", name: `Stream Overlay ${tag}`, visibility: "public",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Overlay", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: `Overlay Home ${tag}`, seed: 1, members: [] },
    { kind: "individual", display_name: `Overlay Away ${tag}`, seed: 2, members: [] },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" }),
  );
  const fx = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST"),
  ).fixtures[0]!.id;
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");

  const denied = await html(admin, `/overlay/fixtures/${fx}`);
  check("stream overlay: 404 for an org with no streaming.overlay row", denied.status === 404);

  await insertEntitlementOverride(admin, proOrgId, "streaming.overlay", true);
  const allowed = await html(admin, `/overlay/fixtures/${fx}`);
  check("stream overlay: 200 once the override row exists", allowed.status === 200);
  check(
    "stream overlay: the page really rendered the stage (not a 200 with no chunks)",
    allowed.body.includes('data-testid="ovl-root"'),
  );

  const link = "https://www.youtube.com/watch?v=smoke";
  const saved = v1data<{ stream_url: string | null }>(
    await v1(admin, `/api/v1/fixtures/${fx}/stream`, "PUT", { streamUrl: link }),
  );
  check("stream overlay: PUT /stream accepts an allowlisted link", saved.stream_url === link);

  const publicJson = v1data<{ stream_url: string | null }>(await v1(admin, `/api/v1/public/fixtures/${fx}`));
  check(
    "stream overlay: the saved link arrives on the PUBLIC fixture JSON (the seam)",
    publicJson.stream_url === link,
  );

  const bad = await raw(admin, `/api/v1/fixtures/${fx}/stream`, "PUT", { streamUrl: "https://evil.example/www.youtube.com" });
  check("stream overlay: an off-allowlist host is refused (4xx)", bad.status >= 400 && bad.status < 500);

  await insertEntitlementOverride(admin, proOrgId, "streaming.overlay", false);
}
```

  and the call, immediately after `await scorePadV2AppendSuite(admin, org2.id);` (`:784`):

```ts
  await streamOverlaySuite(admin, org2.id);
```

- [ ] **Step 7: Run smoke against the prod build.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && SMOKE_BASE=<ovl base> DATABASE_URL=<the ovl url> DATABASE_SSL=disable node --experimental-strip-types scripts/smoke.ts 2>&1 | grep -a "stream overlay"`
  Expected: seven `PASS  stream overlay: …` lines and no `FAIL`. A `FAIL` on the seam line is the inert-seam class this suite exists for — fix the column list, not the assertion.

- [ ] **Step 8: The visual gate — one seed kind and the manifest rows (amended 2026-09-07; the capture spec this step used to write is retired).** The harness is T1b's (`apps/web/e2e/visual/capture.spec.ts`, `docs/runbooks/visual-gate.md`); this wave adds ONE seed kind and rows, never harness code.

  (a) In `apps/web/e2e/visual/seeds.ts`: add `"overlay-fixture"` to `SEED_KINDS`; to `SEED_PARAMS`: `["orgSlug", "compSlug", "divSlug", "cricketFixtureId", "footballFixtureId", "tennisFixtureId", "volleyballFixtureId", "scheduledFixtureId", "missingFixtureId"]`; and the seed:

```ts
/** Stream overlay W1 — the entitled org, four short REAL streams (one per
 *  sport the sheet draws), one fixture with no events (the "—" state), and a
 *  well-formed id that exists nowhere (the 404 state). The entitlement is
 *  lifted by the SAME SQL upsert stream-overlay.spec.ts uses and thawed to
 *  FALSE by that spec's afterAll — this seed only lifts. */
async function overlayFixture(page: Page): Promise<Record<string, string>> {
  const request = page.request;
  const org = await activeOrg(page);
  await setBoolEntitlementOverrideSql(org.id, "streaming.overlay", true);
  await invalidateOrgEntitlements(request, org.id);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Overlay visual ${TAG}`, visibility: "public", ends_on: "2030-12-31",
  });
  const out: Record<string, string> = { orgSlug: org.slug, compSlug: comp.data!.slug, missingFixtureId: "00000000-0000-4000-8000-000000000000" };
  for (const sport of ["cricket", "football", "tennis", "volleyball"] as const) {
    const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
      { name: sport, sport_key: sport, variant_key: sport === "cricket" ? "t20" : "", config: {} });
    await addEntrantsViaApi(request, div.data!.id, ["Milton Keynes Rovers Cricket Club First XI", "Northbridge Athletic"]);
    const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "L" });
    await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
    const fx = fixtureIds[0]!;
    // RE-PIN each opener against its module before running; a refused append
    // photographs the empty state and the mustDiffer pair then fails honestly.
    const opener: Record<string, { type: string; payload: unknown }[]> = {
      cricket: [{ type: "cricket.toss", payload: { winner: "home", decision: "bat" } }, { type: "core.start", payload: {} }],
      football: [{ type: "core.start", payload: {} }, { type: "football.goal", payload: { by: "home", at: { period: "H1", elapsed: 761 } } }],
      tennis: [{ type: "core.start", payload: {} }, { type: "tennis.point", payload: { wonBy: "home" } }],
      volleyball: [{ type: "core.start", payload: {} }, { type: "volleyball.rally", payload: { wonBy: "away" } }],
    };
    let seq = 0;
    for (const ev of opener[sport]!) {
      const res = await apiJson(request, `/api/v1/fixtures/${fx}/events`, "POST", { expected_seq: seq, ...ev });
      if (res.status !== 201) throw new Error(`seed overlay-fixture: ${sport} ${ev.type} → ${res.status} ${res.error?.message ?? ""}`);
      seq += 1;
    }
    out[`${sport}FixtureId`] = fx;
    if (sport === "cricket") {
      out.divSlug = div.data!.slug;
      out.scheduledFixtureId = fixtureIds[1]!; // the league's second fixture: no events, "—"
    }
  }
  return out;
}
```

  (add `setBoolEntitlementOverrideSql`, `invalidateOrgEntitlements`, `addEntrantsViaApi`, `createStageAndGenerate` to the `../helpers` import, and the `case "overlay-fixture": return overlayFixture(page);` arm to `seedFor`).

  (b) Append to `apps/web/e2e/visual/manifest.json`'s `groups` — the `overlay` group: for each `sport` in `cricket, football, tennis, volleyball` and each `style` in `bar, bug` and each `backdrop` in `light, dark`, one row `{ "id": "<sport>-<style>-<backdrop>", "route": "/overlay/fixtures/{<sport>FixtureId}?style=<style>", "viewport": { "width": 1920, "height": 1080 }, "backdrop": "<backdrop>", "awaitSelector": "[data-testid=ovl-root]", "controlRoot": null, "checks": [] }` (sixteen rows; the overlay has no controls and no page scroll — its gate is the CONTRAST test and the pictures); plus `{ "id": "scheduled-bug-dark", "route": "/overlay/fixtures/{scheduledFixtureId}", … "backdrop": "dark", "awaitSelector": "[data-testid=ovl-root]" }` and `{ "id": "missing-404", "route": "/overlay/fixtures/{missingFixtureId}", "viewport": { "width": 1280, "height": 800 }, "backdrop": null, "awaitSelector": "h1", "auth": true }` (RE-PIN: read `apps/web/src/app/not-found.tsx` for the element the 404 page renders and use its selector). `mustDiffer`: every `<sport>-bar-light` vs `<sport>-bug-light` (four pairs), every `<sport>-bar-light` vs `<sport>-bar-dark` (four pairs), `cricket-bar-light` vs `football-bar-light`, and `scheduled-bug-dark` vs `cricket-bug-dark`.

  And the `console-panel` group, seed `overlay-fixture`, `auth: true` on every row: routes `/o/{orgSlug}/c/{compSlug}/d/{divSlug}?tab=fixtures&stream={cricketFixtureId}` (Task 6 Step 3b makes `?stream=<fixtureId>` open that row's panel — the same parameter R1's Stripe `success_url` returns to), rows `panel-320` (320×568), `panel-320-zoom125` (320×568, `zoom: 1.25`), `panel-768` (768×1024), `panel-1280` (1280×800); `awaitSelector: "[data-testid=fixture-stream-panel]"`; `controlRoot: "[data-testid=fixture-stream-panel]"`; checks on every row `["no-horizontal-scroll", "no-clip", "hit-targets", "truncate-chain", "rails-a11y"]` (drop `hit-targets` on `panel-1280` only); `mustDiffer: [["panel-320", "panel-1280"], ["panel-320", "panel-320-zoom125"]]`; `controlSetEqual: [["panel-320", "panel-1280"]]` — the checklist's control-SET diff, membership and order and repeats, asserted by the harness rather than eyeballed.

  Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/visual-manifest.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t8-manifest.json` → `numFailedTests: 0` (a dangling id or an unprovided placeholder fails HERE, in seconds).

- [ ] **Step 9: Run the harness and read the pictures.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh rebuild --label ovl > /dev/null 2>&1; echo "EXIT=$?"` then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && VISUAL_DIR=/tmp/ovl-w1/shots PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/visual/capture.spec.ts --project=parallel --reporter=line > /tmp/ovl-w1/visual.log 2>&1; echo "EXIT=$?"; tail -6 /tmp/ovl-w1/visual.log; ls /tmp/ovl-w1/shots | wc -l`
  Expected: `4 passed` (the two T1 groups plus `overlay` and `console-panel`), 24 PNGs for this wave plus T1's six, every `mustDiffer` pair different, the `[control-set console-panel]` block printing the SAME list for 320 and 1280. Then OPEN every picture (the Read tool renders PNGs) and write one verdict line per screen into the PR inventory — alignment against `_THEMES.md` §3/§4 by `getComputedStyle` at 1920×1080 (the reviewer measures, the executor records), the 43-character name, LED position, legibility over the LIGHT and the DARK frame, the 404 and the "—" state, the panel at 320 with every control 44 px and the same set as 1280, and the 125 % row visibly larger at the same window. "CI green" is not a visual sign-off; the owner signs per screen.

- [ ] **Step 10: Update `_INDEX.md`.** In `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`: flip the plan row to `done`, the PR1 row to `in flight`/`merged` with its number, record the LANDED migration numbers (V400/V393 or whatever the rebase gave them), and add the findings this wave produced — the `useLiveFixture` return-type conflict, `OverlayMsg` vs `MsgFn`, `decidedTemplates` as an input, `startLabel` formatted server-side in UTC (no public venue zone), watch-list 6 resolved to the three-letter fallback (`public_entrants_v` carries no `short_name`), `header.clock` empty in W1, the "Replay" label needing a reload, and whatever `--sport-*` contrast or `m.youtube.com` question the run raised.

- [ ] **Step 11: Wave-boundary gate — the full suite, against the baseline.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npx vitest run --reporter=json --outputFile=/tmp/ovl-w1/full.json`
  Expected: `numFailedTests: 5` and no more — the SAME five as the baseline (3 × `schedule-build-honours-locks.test.ts`, 2 × `pass-scoping-guard.test.ts`), and `numTotalTests` ≥ 14041 + this wave's new tests. Confirm the five by name in `.testResults[]`, and confirm every `.testResults[].name` resolves inside this worktree. Then:
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && rtk proxy npm run lint` → read `✖ 0 problems`;
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npx tsc --noEmit -p apps/web/tsconfig.json; echo "EXIT=$?"` → `EXIT=0`;
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npm run openapi:gen` and `pnpm i18n:gen-keys`, then `/usr/bin/git status --porcelain` → no diff from either.

- [ ] **Step 12: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/e2e/walkthrough/stream-overlay.spec.ts apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts apps/web/e2e/visual/seeds.ts apps/web/e2e/visual/manifest.json scripts/smoke.ts docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(tests): e2e both gate directions, smoke through the seam, and the visual gate" -m "The e2e drives a real cricket ledger and asserts the score moves without navigating; smoke proves the saved link reaches the public JSON; the capture harness asserts eight images that exist and differ." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

- [ ] **Step 13: Post-rebase (R11, R10) — amended 2026-09-07.** Desk W1 (#708) and desk W2 (#725) are MERGED; the live contention on `run-sheet-row.tsx` is **desk W3** (`feat/competition-desk-w3-band-and-phone`). Before opening PR1, `/usr/bin/git fetch origin main && /usr/bin/git log --oneline origin/main -- apps/web/src/components/v2/desk/run-sheet-row.tsx | head -3` — if W3 has landed, rebase on `main`, re-read `:377`'s neighbourhood, and re-place Task 6's one conditional line; then in the SAME commit `ls db/migration/deltas | sort -V | tail -1` and renumber V400/V401 to the next free numbers if either was taken (a duplicate Flyway version survives a clean rebase — three times now). Re-run the WHOLE `mobile.spec.ts` at seven widths AFTER the rebase, not before, re-run Step 11's full gate, and re-run the visual harness (Step 9). e2e pre-merge: `workflow_dispatch pr=<n>` on `e2e.yml`.

---

## Self-review

### Spec and wave-prompt coverage

| Source section | Task |
|---|---|
| Owner answer 12 (Q1) — venue zone on the public payload | 0 (payload), 2 (`overlayStartLabel`), 5 (page) |
| Owner answer 12 (Q1) — cricket balls remaining, "Need 45 off 45" (`_THEMES.md` §3/§4) | 0 (`OverlayLiveData.cricket.innings[].ballsLimit`, off the folded state), 2 (`chaseBalls(data.cricket)`, `overlay.chase.needBalls`), 5 (dictionaries) |
| Owner answer 12 (Q1) — football match clock, `header.clock` (`_THEMES.md` §3/§4); owner 2026-09-06: it TICKS | 0 (`OverlayLiveData.clock` anchor), 5 (Step 8a `useOverlayClock`, the one 1 Hz timer; the bar/bug clock cells), 2 (`formatClock`, `clockLabel` input) |
| Owner answer 13 (Q2) — no consent banner on the overlay segment | 5 (Steps 4a, 4b), 8 (the e2e absence + cookie assertions) |
| Owner answer 14 (Q3) — Supabase realtime, override grants both keys | Global Constraints, 4 |
| Owner answer 17 (Q14) — the override row IS the hiding gate | Global Constraints, 4, 5 (the `notFound()` gate) |
| Owner answer 16 (Q5) — `m.youtube.com` on the host allowlist | 3 (`STREAM_HOSTS`, the accepted row, and the look-alike rejections that keep it exact) |
| Owner answer 17 (Q6) — the stream panel opens at EVERY fixture status | 6 (the ruling paragraph and Step 3a's decided-status row + both negative pairs) |
| Owner answer 18 (Q7) — themes are a REGISTRY, not a union | Global Constraints, 5 (Steps 6a–6d build it; 7 resolves through it; 8 renders `theme.component`), 6 (tabs map over `themesForSport`) |
| Owner answer 19 (Q16) — one service, overlay data path over `foldFixture` | 0 (the FINDING at the head — the folded state already carries both in-match numbers; Steps 2–13 marked superseded pending the owner) |
| Spec §1 Overlay route (layout, page, canvas, stage) / prompt scope 5 | 5 |
| Spec §2 Projection (`OverlayModel`, `overlayModel`) / prompt scope 2 | 2 |
| Spec §3 Theme (`sportThemeStyle`, seven tokens, `.ovl-*`) / `_THEMES.md` §1–§4 | 5 |
| Spec §4 Data (V400, view, `PublicFixture`, `PUT /stream`, OpenAPI) / prompt scope 3 | 3 |
| Design §3.2 — the overlay endpoint, `OverlayLiveData` verbatim, fold cached on `last_seq`, zero engine edits (owner answers 12, 19; Q15 closed) | 0 (Steps 5–13), 1 (the generic fetcher), 8 (the endpoint e2e case) |
| Design §3.3 — `useLiveFixture` generic over `{ fetcher, delayMs? }`, `presentationNowOffsetMs`, `LiveScore` byte-identical | 1 (Steps 1, 2a, 3, 4, 5) |
| Design §5.1 / §5.3 — both keys `false` on five plans (V401); the Phone tab reads the gate from PR1 (D-W1-1) | 4, 6 (Step 3b) |
| Design §4.2 / T1b — this wave adds manifest rows and one seed kind, never harness code | 8 (Steps 8a, 8b, 9) |
| Spec §5 Entitlement (`streaming.overlay`, no plan, override row) / prompt scope 4 | 4 |
| Spec §6 Organiser panel / prompt scope 6 / `_THEMES.md` §8 | 6 |
| Spec §7 Public match page link / prompt scope 7 | 7 |
| Spec §8 Sequencing with in-flight programmes (R11) — desk W3 on `run-sheet-row.tsx` (re-pinned 2026-09-07) | 8 (Step 13) |
| Spec §9 Motion — the three W1 motions / `_THEMES.md` §6 / R13 | 5 (CSS + stage), proven in 8 |
| Spec "Error and empty states" (404 both causes, scheduled "—", decided, no-detail sports) | 2 (unit), 5 (render), 8 (e2e) |
| Spec "Tests" — Unit | 0, 1, 2, 3, 4, 5 |
| Spec "Tests" — E2E | 8 (with 7's block) |
| Spec "Tests" — Smoke | 8 |
| Spec "Tests" — Regression (`LiveScore` unchanged, `mobile.spec.ts`, gen diffs) | 1, 8 (Steps 5, 11) |
| Spec "Tests" — Visual gate (T1b manifest rows: bar + bug × four sports × light + dark, "—", 404; panel 320/768/1280/320 @ 125 % with control-set-equal) | 8 (Steps 8–9) |
| Prompt scope 1 Hook extraction | 1 |
| Prompt scope 8 i18n (four locales, gen-keys, derived coverage test) | 5, 6 |
| Prompt scope 10 `_INDEX.md` | 8 (Step 10) |
| R4 `OverlayMoment` type + `ovl-moment-slot`, W2 compatibility | 2, 5 |
| `_THEMES.md` §2 contrast floors | T1 Task 2 (the derived sweep); 5 (Step 10 — a role row only if a new pair is painted) |
| `_THEMES.md` §7 phone legibility floors (no native size lowered) | 5 (CSS values are §3/§4 verbatim), reviewed in 8 Step 9 |

### Mutation checks — each names the test that must go red

| # | Mutation | Test that must go red |
|---|---|---|
| g | `data.ts`: delete the venue-zone query and hardcode `venueTz: "UTC"` | `public-fixture-venue-tz.test.ts` › `falls back to the organisation's zone when the division has no schedule_settings row` — `expected 'UTC' to be 'Asia/Kolkata'` (Task 0 Step 14.1) |
| h | `server/overlay/load.ts`: cache keys `["overlay-fold", fixtureId]` (drop `last_seq`) | `load.test.ts` › `folds AGAIN when the ledger advances` — `expected "spy" to be called 2 times, but got 1` (Task 0 Step 15.2, amended 2026-09-07) |
| i | `server/overlay/project.ts` `clockOf`: delete `asOf.period !== s.phase \|\|` | `project.test.ts` › `between periods the clock is ABSENT` — `expected { phase: 'HT', … } to be undefined`; and `stream-overlay.spec.ts` › the endpoint case, which posts a period change and expects no `clock` (Task 0 Step 15.3) |
| j | `server/overlay/project.ts` `cricketOf`: swap `runs` and `wickets` | `project.test.ts` › `cricket: every innings' runs…` — `toMatchObject` names `runs`; and `overlay-model.test.ts` › `renders 'Need 45 off 45'…` through `chaseBalls(data.cricket)` (Task 0 Step 15.4) |
| j2 | `components/overlay/use-overlay-clock.ts`: `displayed = anchorSeconds + (now − anchorAtWallMs)` without `− presentationNowOffsetMs` | `use-overlay-clock.test.ts` › `subtracts the presentation offset…` — the R2 alignment e2e's unit-level twin (Task 5 Step 8a); and the R2 alignment e2e later |
| j3 | `components/overlay/use-overlay-clock.ts`: delete the hold — return `null` when `clock` is absent | `use-overlay-clock.test.ts` › `holds the last displayed value at half-time…` (Task 5 Step 8a) |
| k | `cookie-consent.tsx`: delete the `pathname?.startsWith(OVERLAY_SEGMENT)` guard, so the banner renders on the overlay segment | `cookie-consent-overlay-segment.test.tsx` › `renders nothing under /overlay/…`, and `stream-overlay.spec.ts` › `the page is transparent…` on `not.toBeAttached()`. Run the e2e as well as the unit: the unit alone cannot see the root layout that mounts it. |
| a | `stream-url.ts`: `return ALLOWED.has(url.hostname)` → `return true` | `stream-url.test.ts` › `rejects https://evil.example/www.youtube.com — an allowed host in the PATH is not the host` (and the other nine rejections) |
| b | `overlay-model.ts` `ledEntrantId`: swap the serving branch's two side ids | `overlay-model.test.ts` › `tennis: the LED and the serve dot follow the server` |
| c | `overlay-model.ts` `cellsOf`: `if (breakdown) return [];` | `overlay-model.test.ts` › `badminton renders one cell per game, in order, home–away` |
| d | `use-live-fixture.ts`: `if (!live || subscribed) return;` → `if (subscribed) return;` | `use-live-fixture.test.tsx` › `never arms a poll for a fixture that is already decided at mount` |
| e | `overlay/.../page.tsx`: delete the `hasFeature` guard | `stream-overlay.spec.ts` › `the entitlement gate opens and closes the route, in both directions` (e2e only — no unit can see it) |
| f | `overlay-bar.tsx`: remove ` ovl-tick` from the score `className` | `stream-overlay.spec.ts` › `a new event changes the score in place, ticks only the side that moved, and never navigates` |
| l | `theme-registry.ts` `resolveThemeFrom`: delete the `sports` filter — `if (requested && suits(requested, sportKey))` → `if (requested)` | `theme-registry.test.ts` › `falls back when the requested theme does not list the fixture's sport` — `expected 'bar' to be 'bug'`. **Only the PROBE registry can kill this**: both shipped themes are `sports: "all"`, so a test written against `OVERLAY_THEMES` alone would survive the mutation. A surviving (l) means the probe is wrong, not the code (Task 5 Step 6d) |
| m | `theme-registry.ts` `resolveThemeFrom`: `return OVERLAY_THEMES[fallback];` → `throw new Error("unknown theme")` | `theme-registry.test.ts` › `falls back on an unknown or misspelt id, and never throws` — nine `not.toThrow()` failures. This is the mutant that stands for "an OBS browser source cannot be asked to fix a typo mid-match" (Task 5 Step 6d) |
| n | `theme-registry.ts` `resolveTheme`: `defaultThemeFor(sportKey)` → `"bug"` | `theme-registry.test.ts` › `falls back to THE SPORT'S default, not to a hardcoded one` — `expected 'bug' to be 'bar'`. Without the cricket/football differential row this mutant survives every other assertion in the file |
| extra | `V400`: drop `stream_url` from the view redefinition | `fixture-stream-url.test.ts` › `writes the link … and it arrives on the PUBLIC view`, and smoke's `the saved link arrives on the PUBLIC fixture JSON (the seam)` |
| extra | `entitlement-domains.ts`: add `"streaming.overlay"` to any section | `entitlement-streaming-overlay.test.ts` › `is in NO ENTITLEMENT_DOMAINS section` |

A surviving mutant is a missing test, not a note. Run each one, restore, and re-run to green before recording it.

### Open pins — carried into `_INDEX.md`, not silently resolved

1. **Entrant short name (watch-list 6) — RESOLVED to the fallback.** `public_entrants_v` (`V350__person_tombstone_views.sql:18-47`) exposes `display_name` and a `team_display` blob of `club_id/club_name/logo_path/colors`; `teams.short_name` (`V206:5`) never reaches it. `shortCode` therefore always takes the three-letter branch, and `ui.stream.codeNote` tells the organiser so.
2. **CLOSED by owner answer 12 (2026-09-06) — venue timezone for `startLabel`.** Was: "formatted in UTC, no IANA zone on `PublicFixture`". Now Task 0 puts `venueTz` on `getPublicFixture` via `resolveVenueTz`, and `overlayStartLabel` formats with it. W1 **deviation 4 is closed**; nothing is owed here.
3. **CLOSED by owner answer 12 (2026-09-06) — `header.clock` (football family), and the cricket chase line.** Was: "no elapsed-time field exists on the public `ScoreSummary.detail`" and "the chase reads 'Need 45', not 'Need 45 off 45'". Amended 2026-09-07: Task 0 projects `OverlayLiveData.clock` (the anchor, under `footballPosition`'s own staleness guard) and `OverlayLiveData.cricket.innings[].ballsLimit` off the folded state through the overlay endpoint — no engine field is added, so the §9.6 obligation the 09-05 plan carried is GONE (nothing coarsens, nothing re-baselines). W1 **deviations 4 and 6, and the unpinned football clock, are all closed by the owner's answers**, and the clock TICKS (Task 5 Step 8a). `_STATE.md`'s copy of the eight-deviation list is a SEPARATE file and is not edited by this plan; whoever updates `_INDEX.md` at PR time strikes 4 and 6 there.
4. **CLOSED by owner answer 16 (Q5), 2026-09-06 — `m.youtube.com`.** Was: "not on R16's ten; the unit test asserts it is REJECTED". The owner answered *"Agree"*, so it is the eleventh entry in `STREAM_HOSTS` with its own accepted row, and two look-alike rejections (`m.youtube.com.evil.example`, `mm.youtube.com`) were added in the same edit so the widening stays an exact-hostname addition rather than a suffix rule. **R16 in `_RULES.md` still says ten and is now stale** — whoever updates `_INDEX.md` at PR time records the widening there; this plan does not edit `_RULES.md`.
5. **Barlow double-mount (watch-list 7).** Verified in Task 5 Step 12 by reading the built CSS and the network tab, not by assumption.
6. **`V3_SKINS` = every `sport_key` a division can carry (watch-list 8).** Task 2's sweep asserts eleven keys; run `select distinct sport_key from divisions` on the ovl DB and diff before the PR — a division on a twelfth key would render the generic composition, which is a designed state but should be a KNOWN one.
7. **CLOSED 2026-09-07 @ fb99bbd4c — `WALKTHROUGH_SPECS` exists** (`e2e-ci-wiring.test.ts:16`, on `main` since #723). Task 8 Step 1 registers `stream-overlay.spec.ts` in its own commit. The capture spec is retired in favour of T1b's manifest, so one name, not two.
8. **CLOSED 2026-09-07 — the engine conflict no longer exists.** Was: Task 0 edits four engine files because the live transport carries only `{ status, summary, outcome }`. Now: the overlay ENDPOINT (design §3.2, owner Q16/Q15) projects the two numbers off the folded STATE `foldFixture` already returns, through the engine and changing no engine file; Task 1's hook is generic over its fetcher so the overlay polls that endpoint and `LiveScore` keeps the public JSON. The "second authority" objection that rejected the server-side graft on 2026-09-05 is answered by reading the engine's own state fields (`asOf`, `innings[].ballsLimit`) rather than re-deriving them, and by keeping `footballPosition`'s staleness guard verbatim in `clockOf`. `/usr/bin/git status --porcelain packages` is empty at every gate.
8a. **FS13 (2026-09-07) — the design's RP3 pin was wrong; this plan's is right.** `grep -al public_fixtures_v db/migration/deltas/*.sql | sort -V | tail -1` → `V369__public_fixtures_round_role.sql:18` is the latest definer on `main`; the design's `V362:22` is the 2026-09-06 consolidation's stale scout pin. `_INDEX.md` records FS10 and the design's §13.2 row is corrected at PR1.
8b. **Plan decision D-W1-1 (2026-09-07) — the Phone tab ships in W1 with its buy card DISABLED, not absent.** Design §3.8 says W1 ships the Phone tab "showing the upgrade or buy card and nothing else until R1"; a buy card whose buttons POST to a route that does not exist until R1 is an inert seam. So: no `streaming.relay` → `UpgradeGate` (real, tested); `streaming.relay` (override only, while dark) → the three pack tiles rendered `disabled` with `aria-disabled` and `ui.stream.phone.soon` copy in four locales, asserted disabled by the e2e. R1 removes the `disabled` and the copy in the same change that adds the checkout route. Reviewer: this is a designed state with a named owner, not a stub — if the owner would rather the tiles not render at all until R1, that is one prop.
9. **Themes are a registry (owner answer 18 / Q7) — recorded so the review checks the ABSTRACTION, not just the two themes.** The claim W1 now makes is "a third theme is one registry entry plus one component". It is provable, and the reviewer should prove it rather than take it: add a throwaway third entry, confirm it appears in the panel's tabs and resolves on the route, and confirm that neither `page.tsx`, `overlay-stage.tsx` nor `fixture-stream-panel.tsx` needed an edit — then delete it. A registry nothing has ever been added to is a registry whose claim is untested. (The one honest caveat: the `ThemeId` union is declared in the registry file, so a third theme is two lines in ONE file, not one. That is deliberate — see the type's comment in Task 5 Step 6c — and it is still no edit outside the registry.)
10. **The registry's `sports` filter has no production user on day one.** Both shipped themes are `sports: "all"`. Designed, not an oversight, but it means the filter's ONLY cover is the probe registry in `theme-registry.test.ts`. If a later wave deletes that probe as "redundant", mutant (l) stops being killable and the filter silently becomes decoration.
11. **Conflicts with the wave prompt, listed for `_INDEX.md`:** the hook's return type (object, not bare `LiveFixtureData` — `LiveScore` renders `subscribed`); `OverlayMsg` instead of `MsgFn` (`MessageKey` is the `ui` catalog, the overlay's copy is `public`); `decidedTemplates` as a fourth model input (one authority for the decided sentence); `startLabel` formatted by the server; W2's plan names `apps/web/e2e/stream-overlay.spec.ts` while the W1 prompt's R9 puts it under `e2e/walkthrough/` — the W1 prompt wins and W2 re-pins. **And two the owner's later answers create, where the OWNER wins over both the prompt and the spec:** the wave prompt and the spec both describe `style=bar|bug` as a two-value query parameter with a per-sport default, which owner answer 18 (Q7) replaces with the registry; and R16's ten-host allowlist, which owner answer 16 (Q5) widens to eleven. Neither `_RULES.md` nor `W1-step-one.md` is edited by this plan — `_INDEX.md` records both supersessions at PR time.

