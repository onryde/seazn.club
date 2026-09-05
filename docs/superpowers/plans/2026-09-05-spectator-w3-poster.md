# Spectator W3 — Match Poster Implementation Plan

> **Status:** DRAFT — re-pin file:line references after W1/W2 merge; not yet approved for execution.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every public fixture page a downloadable, share-ready match poster — upcoming, live and result variants at Instagram feed (1080×1350) and story (1080×1920) sizes — rendered from the same match-centre document the page shows, with real crests, the competition's colours, the title sponsor and the free-tier "Powered by seazn" footer.

**Architecture:** One `GET …/fixtures/[fixtureId]/poster.png?format=feed|story` route handler renders a satori card through `next/og` `ImageResponse`, exactly as `news/[postSlug]/story.png` does today. A PURE model (`matchPosterModel`) reads W1's `MatchCentreDoc` (scores, status line, batters, top performers — never recomputed here), the division's stage/round and venue zone, the entrants' crests and colours, and the org's branding/entitlement flags, and decides every string and colour on the poster; the card component is a thin flexbox layout over that model. The fixture page gains a `PosterDownload` control (one DOM for phone and desktop) whose two links point at the route; a live poster is never cached (`Cache-Control: no-store`), so every download is a fresh render.

**Tech Stack:** TypeScript 7, Node 26, pnpm; Next.js 16.2.9 App Router (`node_modules/next/package.json:3`), `output: standalone` (`Dockerfile:78-88`); `next/og` `ImageResponse` = satori + resvg (flexbox only, no grid; fonts ttf/otf/woff only — `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/image-response.md:49-52`); `sharp ^0.34.5` (already an `apps/web` dependency, `apps/web/package.json:55`) to normalise badges; vitest (`environment: "node"`, no DOM — `apps/web/vitest.config.ts:129`); Playwright (`walkthrough` project, `apps/web/playwright.config.ts:164-168`); Tailwind with the public-site tokens.

**Spec:** `docs/superpowers/specs/2026-09-04-spectator-surface-design.md` (§"W3 — match poster", standing rules R1–R11, §"Copy and i18n", §"Error and empty states", §"False-premise watch list"). Programme rules: `docs/superpowers/specs/2026-09-04-spectator-prompts/_RULES.md`. Prompt: `docs/superpowers/specs/2026-09-04-spectator-prompts/W3-poster.md`. Owner rulings 1–13 and corrections: `_INDEX.md` beside it (poster A = crest tiles, confirmed for every sport, ruling 10). W0 canvas (poster option A artboards): https://claude.ai/code/artifact/f745adf2-fd1f-4f14-9184-ba6f0eb41978

## Global Constraints

Copied from the spec and the programme rules; every task's requirements include this section.

- Branch `feat/spectator-surface`, worktree `.claude/worktrees/spectator`; never the main checkout. `pnpm install --frozen-lockfile`; **pnpm, never `npm install`**.
- **Route** `…/fixtures/[fixtureId]/poster.png?format=feed|story` (default `feed`), rendered with `next/og` `ImageResponse` exactly as `news/[postSlug]/story.png` is. Caching by status: upcoming `revalidate 60`, live `no-store`, final `revalidate 300`. A private competition's poster 404s like its page.
- **Poster**: **upcoming + live + result** variants on one route, **feed 4:5 (1080×1350) and story 9:16 (1080×1920)**, downloadable from the public fixture page by anyone. Poster **A — crest tiles** on the competition's court colour (owner-confirmed pick).
- **Model** `matchPosterModel(...)` in `server/og/match-poster.tsx` beside `post-card.tsx`, pure and unit-tested; reuses `ogTheme`/`resolvePublicTheme` for the brand colour (WCAG guarded) and `fixtureCardModel`'s youth rule (R3).
- **Fonts**: satori needs real font data per weight; an OFL display + text family (bold and regular) is pinned under `apps/web/public/fonts` with its licence file, used only by image routes. **Badges** are fetched inside the route with a timeout and fall back to the monogram — never a broken image in a poster.
- **R2** — Every string through the `public` dictionary namespace in all four locales, `gen-keys` regenerated. Keys live in `apps/web/src/dictionaries/<locale>/public.json`, flat dotted keys, written BARE inside it — `poster.*` — the namespace is the file, never a prefix on the key. `apps/web/src/lib/i18n-keys.ts` is GENERATED — never hand-edit.
- **R3** — Consent before names. Every person name on a public page or image goes through the public-site consent resolver (W1 resolved names arrive on the document as `Person { name, masked }`; the poster never resolves a name itself). On a poster a masked performer's line is DROPPED, never printed as a mask — a poster is permanent. Youth rule as in `fixtureCardModel` (`apps/web/src/server/og/model.ts:143`: `youth && entrantKind !== "team"` → no entrant names at all).
- **R5** — One authority per fact. Scores, status line, chase line, batters and top performers come from `buildMatchCentre`'s document; the poster never re-derives a cricket rule. Format labels ("8-over match") come from the sport module's config via `describeFormat` — keys, not English.
- **R6** — No new entitlement rows. Match centre, scorecard, commentary and poster are on every plan: they are the growth loop. Existing gates reused as-is — `org.branded` decides the poster footer ("Powered by seazn" vs the org); `sponsors.tiers` decides whether a title tier exists. Entitlements v18 is in flight; this programme adds nothing to its matrix.
- **R7** — Testids on every new control: `poster-…` (spec R7 and `W3-poster.md` §5; the dispatch brief's `mc-poster-*` is NOT used — see open question Q4). Every wave extends `apps/web/e2e/walkthrough/spectator-public.spec.ts` in the `walkthrough` project.
- **R8** — The fixture page adds poster download; the free-tier footer "Powered by seazn" stays on every poster of a non-branded org.
- **R9** — Empty case first: every ladder in the model (variant, tiles, performers, batters, sponsor, format line) states its empty case before its ladder.
- **R10** — Live means live, never reload: a live poster is regenerated on each download, not cached anywhere (response `no-store`, the share path fetches with `cache: "no-store"`); the proof is two downloads around one API-posted ball whose bytes differ.
- **R11** — Visual sign-off, per screen, cosmetics included: the three variants × two formats are rendered on the `spx` prod build with real data and READ by a person; the download control is screenshotted at 320/768/1280 closed and open; a per-screen verdict table is appended to the spec ("W3 sign-off — per-screen verdicts").
- Phone composition, not shrink (R1): one DOM, `max-md:*` branches, no phone-only control (a bottom sheet with its own close button would be one — the control is therefore an inline disclosure on phones and a popover ≥`md`); no horizontal page scroll at 320/360/375/390/430/768/834; tap targets ≥ 44 px hit-tested with `elementFromPoint`.
- Assertions on Next HTML anchor on `="` (an omitted prop serialises as `"$undefined"`).
- Subagents: Opus at minimum (agent frontmatter; never pass `model:`); scoped vitest/tsc only — the orchestrator runs the full gate with `--reporter=json --outputFile` and judges `numTotalTests`/`numFailedTests`, never exit codes; `cd` to the worktree in the SAME call as any verify command; every `apps/web` round ends with `pnpm exec tsc --noEmit -p tsconfig.json` from `apps/web`.
- Commit after every task with a normal-prose message ending in the two trailers `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01TCLYbFJZ8bseHS4kp4nGDa`. In this worktree git commands are plain `/usr/bin/git <verb> …` with no compound shell around them (the isolation guard refuses anything else; it also refuses `for` loops and unquoted `--include=*.ts` globs).
- **Do NOT touch**: the landscape OG card's design (`apps/web/src/server/og/card.tsx`, `og/model.ts`, every `opengraph-image.tsx` — byte-identical at the end of the wave); the competition QR poster / `poster.pdf`; the organiser console; entitlement matrix/copy; the engine; `e2e.yml`.

---

## Rendering technology — pinned, with its constraints

- **Renderer:** `next/og` `ImageResponse` (satori → SVG → resvg → PNG). Nine call sites exist (`grep ImageResponse apps/web/src`): the root OG image, `join/[token]`, `r/[ref]/ticket.png`, the four `/shared` `opengraph-image.tsx` files and `news/[postSlug]/story.png/route.tsx`. Every one of them uses `fontFamily: "sans-serif"` and passes **no `fonts:` option** — satori then falls back to its single bundled default face, so today's `fontWeight: 800` on the OG cards is not a real bold. The poster loads real TTFs (Task 1). No `runtime = "edge"` anywhere in the og code: routes run on Node, so `readFile` works and the 500 KB Edge bundle limit in the docs does not apply to fonts read at request time.
- **Constraints the plan designs around** (`image-response.md:49-52` + satori): flexbox only — every `<div>` declares `display: flex` (the repo's own convention, `card.tsx:3-4`), no `display: grid`; fonts `ttf`/`otf`/`woff` only, **static instances** (a variable `[wght]` font renders at its default axis); `<img>` needs explicit `width`/`height` and a source satori can read — the route passes **data URIs** it fetched itself (timeout, size cap), never a remote URL; satori/resvg decode png/jpeg/gif/svg but not webp, and the badge upload accepts webp (`apps/web/src/server/usecases/entrants.ts:531-534`), so every badge is normalised to a square PNG with `sharp` before it reaches the card.
- **Portrait is new here.** The largest image rendered today is `STORY_SIZE = 1080×1350` (`post-card.tsx:22`); no unit test in the repo decodes an `ImageResponse` PNG (the only `__tests__` mention is a comment, `post-card.test.ts:6`). Task 1 is the spike that proves 1080×1920 renders with custom fonts inside vitest and on the prod build before anything is built on it.
- **Standalone output:** `Dockerfile:81-88` copies `apps/web/public` to `./apps/web/public` and starts `node apps/web/server.js`; Next's generated standalone `server.js` changes directory to its own folder, so `join(process.cwd(), "public", "fonts", …)` is expected to resolve — Task 6 PROVES it on the `spx` prod server through the `X-Poster-Fonts` header rather than assuming it.

## File structure

**Server — `apps/web/src/server/og/`**
- `poster-fonts.ts` — NEW. `POSTER_FONT_FILES` (the four faces), `POSTER_FONT_DIR`, `loadPosterFonts()` (memoised `readFile` → satori font entries).
- `poster-image.ts` — NEW. `toAssetUrl(pathOrUrl)`, `fetchImageDataUri(url, opts)` — timeout, content-type whitelist, size cap, sharp normalisation to a square PNG data URI, `null` on any failure.
- `match-poster.tsx` — NEW (spec name). The PURE model (`matchPosterModel`, `posterVariantFor`, `posterDisplayLine`, `posterCachePolicy`, `posterFileName`, `deterministicColour`, `POSTER_SIZES`, `POSTER_KEYS`) and the satori card (`MatchPosterCard`). Mirrors `post-card.tsx`, which also holds model + card.
- `__tests__/poster-fonts.test.ts`, `__tests__/image-response-contract.test.tsx`, `__tests__/poster-image.test.ts`, `__tests__/match-poster.test.ts`, `__tests__/match-poster-card.test.tsx`, `__tests__/poster-dictionary.test.ts` — NEW.

**Pure, client-safe helper — `apps/web/src/lib/png-size.ts`** — NEW. `pngSize(bytes)` reads the IHDR width/height; used by unit tests, the walkthrough and smoke (no PNG library added).

**Static assets — `apps/web/public/fonts/`** — NEW: `BarlowCondensed-Bold.ttf`, `BarlowCondensed-SemiBold.ttf`, `Geist-Regular.ttf`, `Geist-Bold.ttf`, `OFL-BarlowCondensed.txt`, `OFL-Geist.txt`.

**Server — `apps/web/src/server/public-site/`**
- `describe-format.ts` — owned by the W2 draft (Task 4 there); W3 consumes it, or creates it with W2's exact contract if W2 has not merged (Task 3 here).

**Route** — `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/poster.png/route.tsx` — NEW, plus `poster.png/__tests__/route.test.ts`.

**UI — `apps/web/src/components/public-site/match-centre/`**
- `poster-download.tsx` — NEW client component `PosterDownload` (`poster-menu`, `poster-open`, `poster-feed`, `poster-story`, `poster-share`).
- `__tests__/poster-download.test.tsx` — NEW.
- `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx` — MODIFY: mount `PosterDownload` beside the share control; `__tests__/page.test.ts` extended.
- `apps/web/src/components/public-site/matches-hub/match-card.tsx` (W2) — MODIFY only if W2 has merged: the poster icon link `poster-card-<fixtureId>`.

**Dictionaries** — `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` (+ `npm run i18n:gen-keys` → `apps/web/src/lib/i18n-keys.ts`).

**E2E / smoke** — `apps/web/e2e/walkthrough/spectator-public.spec.ts` (W3 block appended to W1's file); `scripts/smoke.ts` (one check beside W1's fixture check).

---

## Premises to re-pin before execution (this plan is a DRAFT until each is checked)

Every line number below was opened on 2026-09-05 on `feat/spectator-surface` (HEAD after W1 Tasks 1–5, 7, 10–13 landed); W1's remaining tasks are on lane branches and the W2 plan is an unreviewed draft. A false premise is a finding to record in `_INDEX.md`, not a blocker.

| # | Premise | Pinned at | Moves when |
|---|---|---|---|
| P1 | `getPublicFixture(...)` returns `matchCentre: MatchCentreDocT` (W1 Task 9). NOT on this branch yet: today it returns `{ org, competition, division, fixture, entrantNames, realtime }` and `apps/web/src/server/public-site/match-centre.ts` (`buildMatchCentre`) does not exist in `server/public-site/` (listing 2026-09-05: `data.ts, discovery.ts, match-centre-schema.ts, public-lineups.ts, revalidate.ts, timeline.ts`). Tasks 4–9 build on the document; W3 cannot start Task 6 before W1 Task 9 lands. | `data.ts:689-747` | W1 merge |
| P2 | Document shapes the model reads: `Side { entrantId, name, short, colour, badgeUrl }`, `Person { personId, name, masked }`, `MatchCentreHeader { live, status: scheduled\|in_play\|decided\|other, sides, scoreLines, subLines, battingIndex, statusLine: Msg\|null, rateLine, updatedAt }`, `CricketView.live.batters: CricketBattingRow[]` (`person, runs, balls, notOut …`), `CricketView.topPerformers[] { role, person, side, line, detail }`. An EMPTY ledger still yields a document (W1 Task 6 test "EMPTY ledger: header says scheduled"). | `match-centre-schema.ts:11-43` | W1 lane merge (lane C adds `SetsView.unit`, `derivedComplete` — not read here) |
| P3 | The fixture page still renders `LiveScore` + `ShareButton` with no dictionary (`page.tsx:95-185`); W1 Task 14 replaces it with `<MatchCentre>` and (per W1's Interfaces) passes `dict`. Task 8 mounts `PosterDownload` beside whatever share control W1 leaves and adds `getDictionary(locale, "public")` if the page still lacks it. | fixture `page.tsx:9-11,149-157` | W1 Task 14 |
| P4 | `apps/web/e2e/walkthrough/spectator-public.spec.ts` does not exist (W1 Task 15). The seeding helpers live in the W0 harness for now: `postEvent`/`mustPost`/`createPersons`/`playInnings`/`fixtureSides`/`putLineups`/`setScheduledAt` (`w0-spectator-capture.spec.ts:33-262`), `controlSet` (`:266-289`). Task 9 appends a W3 block to W1's file and uses ITS seeded matches (`live`, `done`, `upcoming`) and helpers — re-pin their names then. | W0 harness | W1 Task 15 |
| P5 | `describeFormat` exists nowhere on the branch (`grep -rn describeFormat apps/web/src packages/engine/src` → 0 hits). The W2 DRAFT owns `server/public-site/describe-format.ts` with `describeFormat(sportKey: string, cfg: unknown): MsgT \| null` (W2 plan `:42, :861, :881-895`) and adds `PublicDivision.config` + `dv.config` to `getPublicCompetition`'s SELECT (`:47, :847`). Task 3 is conditional on that. | W2 draft | W2 merge / ownership ruling (Q3) |
| P6 | **Spec watch-list premise is FALSE:** `entrants.badge_url` IS written — `usecases/entrants.ts:381` (insert on create), `:545` (clear), `:562` (upload via `api/v1/entrants/[id]/badge/route.ts`), organiser UI `components/v2/entrants-panel.tsx`. Both crest sources are live and ONE resolver already combines them: `resolveEntrantBadge({ badge_url, team_logo_path })` (`lib/entrant-badge.ts:8-16`: http(s) verbatim, else `publicStorageUrl(path)`). Upload accepts png/jpeg/webp/svg (`entrants.ts:531-534`). | as cited | — |
| P7 | Fonts: `apps/web/public/fonts` does not exist; the app's display face is Barlow Condensed 600/700 (`lib/fonts.ts:7-11`, `next/font/google`) and body Geist (`app/layout.tsx:2,10`) — both served as woff2 by next/font, which satori cannot load. No `fonts:` option is passed anywhere in `apps/web/src` today. | as cited | — |
| P8 | Renderer: `image-response.md:19-35` (options incl. `fonts[] {name, data: ArrayBuffer, weight, style}`, `headers`, `status`), `:49-52` (flexbox only, ttf/otf/woff). `post-card.tsx:22` `STORY_SIZE = 1080×1350` is the largest image rendered today. `story.png/route.tsx:15-18`: a Route Handler must NOT export `contentType` (metadata-file convention); `ImageResponse` sets `content-type: image/png` itself. | as cited | Next upgrade |
| P9 | Standalone layout: `Dockerfile:81-88` (`public` → `./apps/web/public`, `CMD node apps/web/server.js`). `process.cwd()` at runtime is expected to be `apps/web` — proven, not assumed, in Task 6 Step 6 via `X-Poster-Fonts: 4` on the `spx` prod server. Vitest also runs from `apps/web`, so `process.cwd()` matches in tests. | `Dockerfile`, `vitest.config.ts` | Dockerfile change |
| P10 | Theme and youth: `ogTheme(...brandings): OgTheme { court, accent, ink, muted }` (`og/model.ts:30-43`, first branding blob passing the guard wins, else violet `#231738/#7c3aed`); `fixtureCardModel` youth rule `model.ts:143`; `resolvePublicTheme(hex)` contrast guard ≥ 3:1 against white (`lib/public-theme.ts:73-77`); `publicBrandColor(blob)` reads `{ colors: { primary } }` (`:98-104`); `BRAND_PALETTE` — ten guard-passing swatches (`lib/brand-palette.ts:13-24`); `crestMonogram(name)` (`lib/news-presentation.ts:77-87`). | as cited | — |
| P11 | `org.branded` = `org_has_feature(o.id, 'dashboard.branding')` (`data.ts:361`; type `PublicOrg.branded`, `:151`); the page footer today is hardcoded "Powered by Seazn Club" (`shared/[orgSlug]/layout.tsx:110-115`) — W2's i18n sweep owns the PAGE footer; the poster uses its own `poster.poweredBy` key. `PublicOrg.logo` is a resolved URL (`data.ts:369-378`); a competition logo, when present, is `competition.branding.logo_path` (read that way by `usecases/exports.ts:225`). | as cited | W2 |
| P12 | Sponsors: `resolveSponsors(orgId, competitionId?, { tiered })` (`usecases/sponsors.ts:287-`) returns `ResolvedSponsor { id, name, url, logo, tier }` (`:270-276`) where `logo` is the raw `logo_path` (`:308`); tiers exist only when `hasFeature(org.id, "sponsors.tiers", competition.id)` (`[competitionSlug]/page.tsx:13,68`; import `@/lib/entitlements`), otherwise every row collapses to `partner` (`:284-286`). | as cited | — |
| P13 | Stage/round and venue zone: `getPublicDivision` returns `{ stages, pools, fixtures, standings, entrants, tz }` (`data.ts:610-687`), `tz = coalesce(ss.tz, o.timezone, 'UTC')` (`:664-669`); `PublicStage.kind` (`:270-277`); `roundRoleFor(all, target, stageKind)` and `roundRoleLabel(msg, role)` (`lib/round-role-label.ts:90-110, :21-52`) resolve through `ui`-namespace keys `bracket.round.*` via `msgFor(locale, key, vars)` (`lib/messages-i18n.ts:24-33`). | as cited | — |
| P14 | Team colours: `team_display_v.colors = coalesce(t.colors, c.colors)` (`db/migration/jul3/V242__clubs_and_imports.sql:76`), typed `unknown` everywhere (`data.ts:322`, `usecases/clubs.ts:21`). The spec asserts a `colors.primary` key; the model reads `primary` defensively and falls back to the palette. Pin the real shape from a seeded club (the import path) during Task 4 and record it. | as cited | — |
| P15 | Existing `poster.*` keys are in the **`ui`** namespace (`dictionaries/en/ui.json:4663-4665`, read by `poster.pdf/route.ts:152-160` through `msgFor`). W3's `poster.*` keys go into **`public.json`** — a different file, no collision; `public.json` has 194 keys in each of the four locales today. | as cited | — |
| P16 | Playwright `walkthrough` project uses `storageState: AUTH_STATE` — it is SIGNED IN (`playwright.config.ts:164-168`); an anonymous context must be created explicitly (`browser.newContext({ storageState: { cookies: [], origins: [] } })`). Helpers: `expectNoHorizontalScroll(page, { allowancePx })` (`e2e/helpers.ts:43-101`), `screenshotAtWidths(page, testInfo, name, widths)` (`:240-252`), `apiJson` (`:122`), `TAG` (`:111`). | as cited | — |
| P17 | Smoke: `check(label, cond)` (`scripts/smoke.ts:91`); the story.png precedent fetches and asserts `content-type` (`:4536-4540`); `bin` is a closure local to `v3ContentApiSuite` (`:15635-15650`), not a shared helper. W1 Task 15 adds a public-fixture check somewhere in this file — W3's check goes beside it and uses its fixture id. | as cited | W1 Task 15 |
| P18 | W2's match card (`matches-hub/match-card.tsx`, W2 draft `:64, :1258` — "W3's poster icon has no DOM in W2") — Task 8 Step 7 adds the icon link only if W2 has merged. | W2 draft | W2 merge |
| P19 | Module resolver and config fields for the format line: `resolveLatestModule(sportKey): AnySportModule` (`apps/web/src/server/engine-db/registry.ts:37`); cricket `ballsPerInnings` (nullable, default 120) and `ballsPerOver` (default 6) (`packages/engine/src/sports/cricket/cricket.ts:49-50`); football `halfMinutes` (default 45, `football.ts:73`); set-based and nested kernels `bestOf` (`setbased/kernel.ts:104`, `nested/kernel.ts:161`). | as cited | engine change |
| P20 | Vitest aliases `server-only` to a stub (`vitest.config.ts:179`) so `import "server-only"` files are unit-testable; `@seazn/engine` is inlined (`:165`); `isolate: true`. `renderToStaticMarkup` from `react-dom/server` is the static-markup pattern W1's component tests use (`components/public-site/match-centre/__tests__/*.test.tsx`). | as cited | — |

---

### Task 1: Fonts, and the renderer spike (portrait 1080×1920 with custom fonts)

**Files:**
- Create: `apps/web/public/fonts/BarlowCondensed-Bold.ttf`, `BarlowCondensed-SemiBold.ttf`, `Geist-Regular.ttf`, `Geist-Bold.ttf`, `OFL-BarlowCondensed.txt`, `OFL-Geist.txt`
- Create: `apps/web/src/server/og/poster-fonts.ts`
- Create: `apps/web/src/lib/png-size.ts`
- Test: `apps/web/src/server/og/__tests__/poster-fonts.test.ts`, `apps/web/src/server/og/__tests__/image-response-contract.test.tsx`, `apps/web/src/lib/__tests__/png-size.test.ts`

**Interfaces:**
- Consumes: `next/og` `ImageResponse(element, { width, height, fonts, headers })` (`image-response.md:17-36`).
- Produces:
  ```ts
  // poster-fonts.ts
  export interface PosterFontFile { name: "Barlow Condensed" | "Geist"; file: string; weight: 400 | 600 | 700; style: "normal"; licence: string }
  export const POSTER_FONT_DIR: string;                       // join(process.cwd(), "public", "fonts")
  export const POSTER_FONT_FILES: readonly PosterFontFile[];  // exactly four entries, in this order: display 700, display 600, text 400, text 700
  export interface PosterFont { name: string; data: ArrayBuffer; weight: number; style: "normal" }
  export function loadPosterFonts(): Promise<PosterFont[]>;   // memoised; rejects (and clears the memo) if a file is missing
  // png-size.ts
  export function pngSize(bytes: Uint8Array): { width: number; height: number };   // throws on a non-PNG signature
  ```

- [ ] **Step 1: Obtain the four static TTFs and their licences**

Static instances only — satori renders a variable `[wght].ttf` at its default axis. Sources (both SIL OFL 1.1): Barlow Condensed from the Google Fonts repository (`https://github.com/google/fonts/tree/main/ofl/barlowcondensed` → `BarlowCondensed-Bold.ttf`, `BarlowCondensed-SemiBold.ttf`, `OFL.txt` → save as `OFL-BarlowCondensed.txt`); Geist static TTFs from the Vercel `geist-font` release assets (`Geist-Regular.ttf`, `Geist-Bold.ttf`, `LICENSE.TXT` → `OFL-Geist.txt`). If the Geist release carries no STATIC TTF instances, use Inter's statics from the same Google Fonts repository (`ofl/inter/static/Inter-Regular.ttf`, `Inter-Bold.ttf`) under the name `"Inter"`, update `POSTER_FONT_FILES` and the card's text `fontFamily`, and record the substitution in `_INDEX.md` (open question Q1). Verify each file before committing:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web/public/fonts && xxd -l 4 BarlowCondensed-Bold.ttf
# expected: 00000000: 0001 0000   (TrueType); "OTTO" would be CFF OpenType — also fine, but then the test's magic check must accept it
node -e 'const b=require("fs").readFileSync(process.argv[1]);const n=b.readUInt16BE(4);const t=[];for(let i=0;i<n;i++)t.push(b.subarray(12+i*16,16+i*16).toString("latin1"));console.log(t.join(" "))' BarlowCondensed-Bold.ttf
# expected: a table list WITHOUT "fvar" (static instance)
```

- [ ] **Step 2: Write the failing font tests**

`apps/web/src/server/og/__tests__/poster-fonts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { POSTER_FONT_DIR, POSTER_FONT_FILES, loadPosterFonts } from "@/server/og/poster-fonts";

function tableTags(buf: Buffer): string[] {
  const n = buf.readUInt16BE(4);
  return Array.from({ length: n }, (_, i) => buf.subarray(12 + i * 16, 16 + i * 16).toString("latin1"));
}

describe("poster fonts (spec §W3 Fonts: OFL display + text family, bold and regular, under public/fonts)", () => {
  it("declares exactly the four faces the card uses, in weight order display 700, display 600, text 400, text 700", () => {
    expect(POSTER_FONT_FILES.map((f) => [f.name, f.weight])).toEqual([
      ["Barlow Condensed", 700],
      ["Barlow Condensed", 600],
      ["Geist", 400],
      ["Geist", 700],
    ]);
  });

  it("every declared file exists, is a STATIC TrueType (magic 00 01 00 00, no fvar table) and ships its OFL licence", async () => {
    for (const f of POSTER_FONT_FILES) {
      const buf = await readFile(join(POSTER_FONT_DIR, f.file));
      expect(buf.subarray(0, 4).toString("hex"), `${f.file} magic`).toBe("00010000");
      const tags = tableTags(buf);
      expect(tags, `${f.file} must be a static instance — satori renders a variable font at its default axis only`).not.toContain("fvar");
      expect(tags, `${f.file} has outlines`).toContain("glyf");
    }
    for (const licence of new Set(POSTER_FONT_FILES.map((f) => f.licence))) {
      expect(await readFile(join(POSTER_FONT_DIR, licence), "utf8")).toMatch(/SIL OPEN FONT LICENSE/i);
    }
  });

  it("loadPosterFonts returns satori entries with real data and is memoised", async () => {
    const a = await loadPosterFonts();
    const b = await loadPosterFonts();
    expect(a).toBe(b);
    expect(a.map((f) => f.weight)).toEqual([700, 600, 400, 700]);
    for (const f of a) expect(f.data.byteLength, f.name).toBeGreaterThan(10_000);
  });
});
```

`apps/web/src/lib/__tests__/png-size.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pngSize } from "@/lib/png-size";

// 1×1 transparent PNG, the smallest valid file (67 bytes).
const ONE_BY_ONE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("pngSize", () => {
  it("reads width and height from IHDR", () => {
    expect(pngSize(new Uint8Array(ONE_BY_ONE))).toEqual({ width: 1, height: 1 });
  });
  it("throws on a non-PNG signature (a JPEG or an HTML error page never passes as a poster)", () => {
    expect(() => pngSize(new Uint8Array(Buffer.from("<!doctype html><html></html>")))).toThrow(/PNG signature/);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && DATABASE_URL= pnpm exec vitest run src/server/og/__tests__/poster-fonts.test.ts src/lib/__tests__/png-size.test.ts --reporter=json --outputFile=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/6262000e-0d12-4731-97e2-7a60369846eb/scratchpad/w3-t1.json; node -e "const r=require('/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/6262000e-0d12-4731-97e2-7a60369846eb/scratchpad/w3-t1.json');console.log(r.numTotalTests,r.numFailedTests,r.numFailedTestSuites)"`
Expected: both suites fail to collect (modules missing) → `numFailedTestSuites` 2.

- [ ] **Step 4: Implement the loader and the IHDR reader**

`apps/web/src/lib/png-size.ts`:

```ts
// Client-safe PNG header reader (no library): the IHDR chunk is always the
// first chunk after the 8-byte signature — width at offset 16, height at 20,
// both big-endian uint32 (PNG spec §11.2.2). Used by unit tests, the spectator
// walkthrough and scripts/smoke.ts to prove a poster's exact dimensions.
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error("not a PNG: bad PNG signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
```

`apps/web/src/server/og/poster-fonts.ts`:

```ts
import "server-only";
// Spectator W3 — the poster's own fonts (spec §W3 "Fonts"). satori needs real
// font data per weight; next/font's woff2 output is unusable by it (ttf/otf/
// woff only), so the four static TTFs live under public/fonts with their OFL
// licences, read once per process and handed to ImageResponse as `fonts`.
// Image routes only — nothing else may import this file.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PosterFontFile {
  name: "Barlow Condensed" | "Geist";
  file: string;
  weight: 400 | 600 | 700;
  style: "normal";
  licence: string;
}

export const POSTER_FONT_DIR = join(process.cwd(), "public", "fonts");

export const POSTER_FONT_FILES: readonly PosterFontFile[] = [
  { name: "Barlow Condensed", file: "BarlowCondensed-Bold.ttf", weight: 700, style: "normal", licence: "OFL-BarlowCondensed.txt" },
  { name: "Barlow Condensed", file: "BarlowCondensed-SemiBold.ttf", weight: 600, style: "normal", licence: "OFL-BarlowCondensed.txt" },
  { name: "Geist", file: "Geist-Regular.ttf", weight: 400, style: "normal", licence: "OFL-Geist.txt" },
  { name: "Geist", file: "Geist-Bold.ttf", weight: 700, style: "normal", licence: "OFL-Geist.txt" },
];

export interface PosterFont {
  name: string;
  data: ArrayBuffer;
  weight: number;
  style: "normal";
}

let memo: Promise<PosterFont[]> | null = null;

export function loadPosterFonts(): Promise<PosterFont[]> {
  memo ??= Promise.all(
    POSTER_FONT_FILES.map(async (f) => {
      const buf = await readFile(join(POSTER_FONT_DIR, f.file));
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return { name: f.name, data, weight: f.weight, style: f.style };
    }),
  ).catch((err: unknown) => {
    memo = null; // a missing file must not poison every later request
    throw err;
  });
  return memo;
}
```

- [ ] **Step 5: Run — both suites green**

Same command. Expected: 5 total, 0 failed.

- [ ] **Step 6: The renderer contract test (the spike, kept permanently)**

`apps/web/src/server/og/__tests__/image-response-contract.test.tsx`:

```tsx
// Spectator W3 Task 1 — the spike that everything downstream stands on. No
// image in this repo is taller than 1350 px and no unit test ever decoded an
// ImageResponse PNG before this file; if next/og cannot render 1080×1920 with
// the pinned fonts under vitest, Task 6's route tests fall back to header-only
// assertions and the PNG decode lives in the walkthrough and smoke only.
import { describe, it, expect } from "vitest";
import { ImageResponse } from "next/og";
import { loadPosterFonts } from "@/server/og/poster-fonts";
import { pngSize } from "@/lib/png-size";

describe("next/og renderer contract for the poster", () => {
  it("renders a portrait 1080×1920 PNG with the four pinned fonts in under 3 s", async () => {
    const fonts = await loadPosterFonts();
    const t0 = performance.now();
    const res = new ImageResponse(
      (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: "100%",
            height: "100%",
            background: "#231738",
            color: "#f7f5fb",
            padding: 84,
            fontFamily: "Geist",
          }}
        >
          <div style={{ display: "flex", fontFamily: "Barlow Condensed", fontWeight: 700, fontSize: 120, lineHeight: 1 }}>
            SOUTHEND BLUE BLAZERS
          </div>
          <div style={{ display: "flex", fontFamily: "Barlow Condensed", fontWeight: 600, fontSize: 72 }}>V</div>
          <div style={{ display: "flex", fontWeight: 400, fontSize: 40 }}>Saturday 6 Sep · 14:00 · Court 2</div>
          <div style={{ display: "flex", fontWeight: 700, fontSize: 40 }}>Powered by seazn</div>
        </div>
      ),
      { width: 1080, height: 1920, fonts },
    );
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ms = performance.now() - t0;
    expect(pngSize(bytes)).toEqual({ width: 1080, height: 1920 });
    expect(bytes.length, "a real render, not a blank frame").toBeGreaterThan(20_000);
    expect(ms, `render took ${Math.round(ms)} ms`).toBeLessThan(3_000);
  });

  it("feed size renders too and DIFFERS from the story bytes (the size option is consumed)", async () => {
    const fonts = await loadPosterFonts();
    const el = <div style={{ display: "flex", width: "100%", height: "100%", background: "#231738" }} />;
    const feed = new Uint8Array(await new ImageResponse(el, { width: 1080, height: 1350, fonts }).arrayBuffer());
    const story = new Uint8Array(await new ImageResponse(el, { width: 1080, height: 1920, fonts }).arrayBuffer());
    expect(pngSize(feed)).toEqual({ width: 1080, height: 1350 });
    expect(Buffer.compare(Buffer.from(feed), Buffer.from(story))).not.toBe(0);
  });
});
```

Run: `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web && DATABASE_URL= pnpm exec vitest run src/server/og/__tests__/image-response-contract.test.tsx --reporter=json --outputFile=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/6262000e-0d12-4731-97e2-7a60369846eb/scratchpad/w3-t1b.json` and read `numTotalTests`/`numFailedTests`. **Record the outcome as a fact in the commit message and in the wave report** — one of exactly two states: (a) GREEN → Task 6's route tests decode real PNGs; (b) RED because `next/og` cannot load its WASM/yoga under vitest (an error mentioning `resvg`, `yoga`, `.wasm` or `fetch` of a file URL) → keep this file but mark the two tests `it.skip` with the error text in a comment, and Task 6 mocks `next/og` and asserts options/headers only; the PNG decode then lives in Task 9 (walkthrough + smoke). A RED for any OTHER reason (a font parse error, a 1920 px limit) is a defect to fix here, not to skip.

- [ ] **Step 7: Commit**

`/usr/bin/git add apps/web/public/fonts apps/web/src/server/og/poster-fonts.ts apps/web/src/lib/png-size.ts apps/web/src/server/og/__tests__/poster-fonts.test.ts apps/web/src/server/og/__tests__/image-response-contract.test.tsx apps/web/src/lib/__tests__/png-size.test.ts` then `/usr/bin/git commit -F <message file>` — message: "og(poster): pin Barlow Condensed 700/600 + Geist 400/700 statics under public/fonts, a memoised satori font loader, an IHDR size reader, and the renderer contract (1080×1920 with custom fonts under vitest: <GREEN|RED-skipped, reason>)" + the two trailers.

---

### Task 2: Image fetcher — timeout, whitelist, size cap, sharp normalisation, monogram fallback

**Files:**
- Create: `apps/web/src/server/og/poster-image.ts`
- Test: `apps/web/src/server/og/__tests__/poster-image.test.ts`

**Interfaces:**
- Consumes: `publicStorageUrl(path)` (`apps/web/src/lib/storage-url.ts:7-11`, returns `""` when `NEXT_PUBLIC_SUPABASE_URL` is unset); `sharp` (`apps/web/package.json:55`).
- Produces:
  ```ts
  export function toAssetUrl(pathOrUrl: string | null | undefined): string | null;  // http(s) verbatim; else publicStorageUrl(path); "" / null → null
  export interface FetchImageOpts { size: number; timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch }
  export async function fetchImageDataUri(url: string | null | undefined, opts: FetchImageOpts): Promise<string | null>;
  // → "data:image/png;base64,…" of a size×size PNG (fit: contain, transparent), or null on ANY failure
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { fetchImageDataUri, toAssetUrl } from "@/server/og/poster-image";
import { pngSize } from "@/lib/png-size";

async function pngOf(w: number, h: number, color = { r: 200, g: 30, b: 60, alpha: 1 }): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer();
}
function ok(body: Buffer, type: string, headers: Record<string, string> = {}): typeof fetch {
  return vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": type, ...headers } })) as unknown as typeof fetch;
}
function decode(dataUri: string): Uint8Array {
  expect(dataUri.startsWith("data:image/png;base64,")).toBe(true);
  return new Uint8Array(Buffer.from(dataUri.slice("data:image/png;base64,".length), "base64"));
}

describe("toAssetUrl", () => {
  it("EMPTY first: null, undefined and blank → null", () => {
    expect(toAssetUrl(null)).toBeNull();
    expect(toAssetUrl(undefined)).toBeNull();
    expect(toAssetUrl("  ")).toBeNull();
  });
  it("http(s) verbatim; a storage path through publicStorageUrl (same rule as resolveEntrantBadge)", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://sb.example");
    expect(toAssetUrl("https://flags.example/x.png")).toBe("https://flags.example/x.png");
    expect(toAssetUrl("orgs/o1/entrant-badges/a.png")).toBe("https://sb.example/storage/v1/object/public/assets/orgs/o1/entrant-badges/a.png");
    vi.unstubAllEnvs();
  });
  it("a storage path with no NEXT_PUBLIC_SUPABASE_URL → null, never an empty string (satori would fetch \"\")", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(toAssetUrl("orgs/o1/x.png")).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("fetchImageDataUri", () => {
  it("EMPTY first: a null url → null without fetching", async () => {
    const f = vi.fn();
    expect(await fetchImageDataUri(null, { size: 480, fetchImpl: f as unknown as typeof fetch })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it("a 300×100 PNG comes back as a size×size PNG data URI (contain, so the badge keeps its aspect)", async () => {
    const uri = await fetchImageDataUri("https://x/badge.png", { size: 480, fetchImpl: ok(await pngOf(300, 100), "image/png") });
    expect(pngSize(decode(uri!))).toEqual({ width: 480, height: 480 });
  });
  it("webp (the badge upload accepts it; satori/resvg do not) is converted to PNG", async () => {
    const webp = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).webp().toBuffer();
    const uri = await fetchImageDataUri("https://x/badge.webp", { size: 240, fetchImpl: ok(webp, "image/webp") });
    expect(pngSize(decode(uri!))).toEqual({ width: 240, height: 240 });
  });
  it("svg is rasterised", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#0f766e"/></svg>');
    const uri = await fetchImageDataUri("https://x/badge.svg", { size: 120, fetchImpl: ok(svg, "image/svg+xml") });
    expect(pngSize(decode(uri!))).toEqual({ width: 120, height: 120 });
  });
  it("404 → null", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchImageDataUri("https://x/missing.png", { size: 480, fetchImpl: f })).toBeNull();
  });
  it("a non-image content-type (an HTML error page served with 200) → null", async () => {
    expect(await fetchImageDataUri("https://x/oops", { size: 480, fetchImpl: ok(Buffer.from("<html>"), "text/html") })).toBeNull();
  });
  it("a body larger than maxBytes → null (declared by content-length, and again by the actual bytes)", async () => {
    const big = await pngOf(64, 64);
    expect(await fetchImageDataUri("https://x/big.png", { size: 480, maxBytes: 100, fetchImpl: ok(big, "image/png") })).toBeNull();
    expect(await fetchImageDataUri("https://x/big.png", { size: 480, maxBytes: 100, fetchImpl: ok(big, "image/png", { "content-length": "50" }) })).toBeNull();
  });
  it("garbage bytes behind an image content-type → null (sharp throws; caught)", async () => {
    expect(await fetchImageDataUri("https://x/bad.png", { size: 480, fetchImpl: ok(Buffer.from("not a png at all"), "image/png") })).toBeNull();
  });
  it("a fetch that never resolves is abandoned at timeoutMs → null (the spec's 'never a broken image')", async () => {
    const hang: typeof fetch = ((_: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(await fetchImageDataUri("https://x/slow.png", { size: 480, timeoutMs: 200, fetchImpl: hang })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_500);
  });
});
```

- [ ] **Step 2: Run — collection failure** (module missing). Same JSON-reporter command shape as Task 1, path `src/server/og/__tests__/poster-image.test.ts`.

- [ ] **Step 3: Implement**

```ts
import "server-only";
// Spectator W3 — every image on a poster (crests, the org/competition logo, the
// title sponsor) is fetched HERE, inside the route, with a timeout and a size
// cap, normalised to a square PNG by sharp (the badge upload accepts webp and
// svg; satori/resvg decode neither webp nor arbitrary sizes well) and handed to
// the card as a data URI. Any failure returns null and the card renders the
// monogram tile — spec §W3: "never a broken image in a poster".
import sharp from "sharp";
import { publicStorageUrl } from "@/lib/storage-url";

const IMAGE_TYPE = /^image\/(png|jpeg|jpg|webp|gif|svg\+xml)(\s*;|$)/i;

export function toAssetUrl(pathOrUrl: string | null | undefined): string | null {
  const v = pathOrUrl?.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const url = publicStorageUrl(v);
  return url ? url : null;
}

export interface FetchImageOpts {
  size: number;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

export async function fetchImageDataUri(url: string | null | undefined, opts: FetchImageOpts): Promise<string | null> {
  if (!url) return null;
  const { size, timeoutMs = 1_500, maxBytes = 2_000_000, fetchImpl = fetch } = opts;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: "image/*" } });
    if (!res.ok) return null;
    if (!IMAGE_TYPE.test(res.headers.get("content-type") ?? "")) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxBytes) return null;
    const png = await sharp(bytes, { density: 300 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null; // 404, abort, network, decode — the caller draws the monogram
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run — green (12 tests).** Then apply and record two mutants in a "Mutants killed" comment block at the top of the test file: (a) delete the `IMAGE_TYPE` check → the `text/html` test reds; (b) delete `clearTimeout`/the `AbortController` → the never-resolves test exceeds its budget and reds. Restore after each.

- [ ] **Step 5: Commit** — "og(poster): image fetcher — timeout, image-type whitelist, size cap, sharp square-PNG normalisation, null on failure".

---

### Task 3: The format line — consume W2's `describeFormat`, or own it

**Runs after checking the tree.** W2's draft owns `apps/web/src/server/public-site/describe-format.ts` and `PublicDivision.config` (P5). This task has two branches; exactly one is executed and the choice is recorded in the wave report and `_INDEX.md`.

- [ ] **Step 1: Check** — `ls /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web/src/server/public-site/describe-format.ts` and `grep -n -a "config" /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator/apps/web/src/server/public-site/data.ts` (looking for `config?: unknown` on `PublicDivision` and `dv.config` in `getPublicCompetition`'s SELECT).

**Branch A — present (W2 merged):** consume `describeFormat(sportKey, cfg): MsgT | null` and `division.config`; nothing to build; commit nothing. Skip to Task 4.

**Branch B — absent:** W3 creates BOTH with W2's exact contract so W2 later drops its own copy (tell the orchestrator in the report — this is the one shared literal the two waves would otherwise both add).

- [ ] **Step 2 (B): Failing tests** — `apps/web/src/server/public-site/__tests__/describe-format.test.ts` (expected values DERIVED from each module's own `configSchema`, never typed constants):

```ts
import { describe, it, expect } from "vitest";
import { resolveLatestModule } from "@/server/engine-db/registry";
import { describeFormat } from "@/server/public-site/describe-format";

describe("describeFormat (spec R5: format labels come from the module's config, as keys)", () => {
  it("EMPTY first: garbage or missing cfg never throws → null", () => {
    expect(describeFormat("cricket", null)).toBeNull();
    expect(describeFormat("cricket", "not an object")).toBeNull();
    expect(describeFormat("no-such-sport", {})).toBeNull();
  });
  it("cricket: overs = ballsPerInnings / ballsPerOver from the PARSED cfg (the W0 seed's 48/6 → 8-over match)", () => {
    const cfg = resolveLatestModule("cricket").configSchema.parse({ ballsPerInnings: 48, playersPerSide: 8 });
    expect(describeFormat("cricket", cfg)).toEqual({ key: "format.cricket.overs", params: { overs: 8 } });
  });
  it("cricket with unlimited overs (ballsPerInnings null) → null — there is no honest number to print", () => {
    const cfg = resolveLatestModule("cricket").configSchema.parse({ ballsPerInnings: null, playersPerSide: 11 });
    expect(describeFormat("cricket", cfg)).toBeNull();
  });
  it("football: halfMinutes from the module cfg (default 45 → 2 × 45 min)", () => {
    const cfg = resolveLatestModule("football").configSchema.parse({});
    expect(describeFormat("football", cfg)).toEqual({ key: "format.football.minutes", params: { minutes: 45 } });
  });
  it("set-based and nested sports: bestOf from the module cfg; generic → null", () => {
    const tennis = resolveLatestModule("tennis").configSchema.parse({});
    expect(describeFormat("tennis", tennis)).toEqual({ key: "format.sets.bestOf", params: { n: (tennis as { bestOf: number }).bestOf } });
    const badminton = resolveLatestModule("badminton").configSchema.parse({});
    expect(describeFormat("badminton", badminton)).toEqual({ key: "format.sets.bestOf", params: { n: (badminton as { bestOf: number }).bestOf } });
    expect(describeFormat("generic", {})).toBeNull();
  });
});
```

- [ ] **Step 3 (B): Run — collection failure.**

- [ ] **Step 4 (B): Implement** `apps/web/src/server/public-site/describe-format.ts`:

```ts
// Spectator W2/W3 — the ONE place a division's configured format becomes a
// label ("8-over match", "2 × 45 min", "Best of 3"). Reads the module's PARSED
// config (rule R5 — never a table typed into a component; the division chip
// that printed "T20" for an 8-over division is the defect this replaces).
// Returns a dictionary key + params; the renderer localises.
import { resolveLatestModule } from "@/server/engine-db/registry";
import type { MsgT } from "./match-centre-schema";

export function describeFormat(sportKey: string, cfg: unknown): MsgT | null {
  if (cfg === null || typeof cfg !== "object") return null;
  let parsed: Record<string, unknown>;
  try {
    const r = resolveLatestModule(sportKey).configSchema.safeParse(cfg);
    if (!r.success) return null;
    parsed = r.data as Record<string, unknown>;
  } catch {
    return null; // unknown sport key
  }
  if (sportKey === "cricket") {
    const bpi = parsed.ballsPerInnings;
    const bpo = parsed.ballsPerOver;
    if (typeof bpi !== "number" || typeof bpo !== "number" || bpo <= 0) return null;
    return { key: "format.cricket.overs", params: { overs: Math.round(bpi / bpo) } };
  }
  if (sportKey === "football") {
    const minutes = parsed.halfMinutes;
    return typeof minutes === "number" ? { key: "format.football.minutes", params: { minutes } } : null;
  }
  const bestOf = parsed.bestOf;
  return typeof bestOf === "number" ? { key: "format.sets.bestOf", params: { n: bestOf } } : null;
}
```

And `PublicDivision.config?: unknown` in `data.ts` (`:190-214`, beside `youth?`), with `dv.config` added to `getPublicCompetition`'s division SELECT (`data.ts:425-436`, the `join divisions dv on dv.id = d.id` is already there). Bump nothing else; the `unstable_cache` key of `getPublicCompetition` is `["pub-comp", …]` — check whether adding a column needs a key bump by reading the existing key at the call site and mirroring W2's convention (W2 bumped `pub-player-v16`); if the comp key carries no version, append `-v2`.

- [ ] **Step 5 (B): Run — green (5 tests); `pnpm exec tsc --noEmit -p tsconfig.json` from `apps/web` clean.** Mutant: swap `bpi / bpo` for `bpi * bpo` → the 48/6 test reds.

- [ ] **Step 6 (B): Commit** — "public-site: describeFormat from the module's parsed config (cricket overs, football halves, best-of); PublicDivision.config — owned by W3 because W2 had not merged".

---

### Task 4: The pure poster model — `matchPosterModel`

**Files:**
- Create: `apps/web/src/server/og/match-poster.tsx` (model half; Task 5 adds the card to the same file)
- Test: `apps/web/src/server/og/__tests__/match-poster.test.ts`

**Interfaces:**
- Consumes: `ogTheme(...brandings): OgTheme` (`og/model.ts:30`), `resolvePublicTheme(hex)` (`lib/public-theme.ts:73`), `BRAND_PALETTE` (`lib/brand-palette.ts:13`), `crestMonogram(name)` (`lib/news-presentation.ts:77`), `t(dict, key, params)` (`lib/i18n-runtime.ts:30`), `describeFormat` (Task 3), the document types `MatchCentreHeaderT`, `CricketViewT`, `SideT` (`match-centre-schema.ts:73-85`).
- Produces (all exported from `match-poster.tsx`):
  ```ts
  export type PosterFormat = "feed" | "story";
  export type PosterVariant = "upcoming" | "live" | "result";
  export const POSTER_SIZES = { feed: { width: 1080, height: 1350 }, story: { width: 1080, height: 1920 } } as const;
  export const POSTER_KEYS = ["poster.live", "poster.timeTbd", "poster.updatedAt", "poster.presentedBy", "poster.poweredBy", "poster.vs", "poster.topPerformers"] as const;

  export interface MatchPosterInput {
    org: { name: string; branded: boolean; branding: unknown };
    competition: { name: string; branding: unknown };
    division: { name: string; youth: boolean; entrantKind: string | null; sportKey: string; config: unknown };
    fixture: { status: string; scheduledAt: string | null; venueName: string | null; courtName: string | null };
    stageLine: string | null;                       // "League · Round 3", resolved by the route (P13)
    header: MatchCentreHeaderT;                     // W1's document header — the ONE authority for status, scores, the status line
    cricket: CricketViewT | null;                   // batters (live) and top performers (result); null for other sports
    logo: string | null;                            // data URI: competition logo, else org logo, else null
    badges: [string | null, string | null];         // data URIs from Task 2, or null → monogram
    sideColours: [string | null, string | null];    // team_display_v.colors.primary (P14), or null → palette
    sponsor: { name: string; logo: string | null } | null;   // the TITLE sponsor only (route decides, P12)
    tz: string; locale: Locale; dict: Dict; now: Date;
  }
  export interface PosterTile { name: string; short: string; monogram: string; colour: string; badge: string | null; score: string | null; sub: string | null; emphasis: boolean }
  export interface MatchPosterModel {
    variant: PosterVariant; theme: OgTheme; logo: string | null;
    eyebrow: string; stageLine: string | null; displayLine: string; livePill: string | null;
    tiles: [PosterTile, PosterTile] | null; youthLine: string | null; vs: string;
    rateLine: string | null; batters: string[]; performers: string[]; performersLabel: string | null;
    formatLine: string | null; whenLine: string | null; whereLine: string | null; updatedLine: string | null;
    sponsor: { name: string; logo: string | null; label: string } | null;
    footer: { kind: "powered" | "org"; text: string };
  }
  export function posterVariantFor(status: string, header: Pick<MatchCentreHeaderT, "status" | "statusLine">): PosterVariant;
  export function posterDisplayLine(variant: PosterVariant, header: Pick<MatchCentreHeaderT, "statusLine">, stageLine: string | null, divisionName: string, dict: Dict, youthHide: boolean): string;
  export function posterCachePolicy(variant: PosterVariant): string;
  export function posterFileName(home: string, away: string, format: PosterFormat): string;
  export function deterministicColour(seed: string): string;   // BRAND_PALETTE[hash(seed) % 10].hex — stable per entrant id
  export function matchPosterModel(input: MatchPosterInput): MatchPosterModel;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import en from "@/dictionaries/en/public.json";
import type { MatchCentreHeaderT, CricketViewT, PersonT, SideT } from "@/server/public-site/match-centre-schema";
import { BRAND_PALETTE } from "@/lib/brand-palette";
import {
  matchPosterModel, posterVariantFor, posterCachePolicy, posterFileName, deterministicColour, POSTER_SIZES,
  type MatchPosterInput,
} from "@/server/og/match-poster";

const dict = en as Record<string, unknown>;
const side = (i: 0 | 1, over: Partial<SideT> = {}): SideT => ({
  entrantId: `e${i}`, name: i === 0 ? "Southend Blue Blazers Cricket Club 1st XI" : "Rochford Ramblers", short: i === 0 ? "SBB" : "ROC", colour: null, badgeUrl: null, ...over,
});
const person = (name: string, masked = false): PersonT => ({ personId: name.toLowerCase(), name, masked });
const header = (over: Partial<MatchCentreHeaderT> = {}): MatchCentreHeaderT => ({
  live: false, status: "scheduled", sides: [side(0), side(1)], scoreLines: [null, null], subLines: [null, null],
  battingIndex: null, statusLine: null, rateLine: null, updatedAt: "2026-09-06T13:32:10.000Z", ...over,
});
const base = (over: Partial<MatchPosterInput> = {}): MatchPosterInput => ({
  org: { name: "Southend CC", branded: false, branding: {} },
  competition: { name: "DJPL 2026", branding: { colors: { primary: "#0f766e" } } },
  division: { name: "Men's T8", youth: false, entrantKind: "team", sportKey: "cricket", config: { ballsPerInnings: 48, ballsPerOver: 6, playersPerSide: 8 } },
  fixture: { status: "scheduled", scheduledAt: "2026-09-06T13:00:00.000Z", venueName: "Garon Park", courtName: "Pitch 2" },
  stageLine: "League · Round 3",
  header: header(), cricket: null, logo: null, badges: [null, null], sideColours: [null, null], sponsor: null,
  tz: "Europe/London", locale: "en", dict, now: new Date("2026-09-05T12:00:00.000Z"), ...over,
});
const DECIDED = header({
  status: "decided", scoreLines: ["142/6", "98/9"], subLines: ["(8.0)", "(8.0)"],
  statusLine: { key: "matchCentre.result.runs", params: { side: "Southend Blue Blazers Cricket Club 1st XI", runs: 44 } },
});
const LIVE = header({
  live: true, status: "in_play", battingIndex: 1, scoreLines: ["142/6", "61/3"], subLines: ["(8.0)", "(4.3)"],
  statusLine: { key: "matchCentre.chase.need", params: { side: "Rochford Ramblers", runs: 82, balls: 21 } }, rateLine: "CRR 13.55 · RRR 23.43",
});
const cricketView = (over: Partial<CricketViewT> = {}): CricketViewT => ({
  band: 3, toss: null, innings: [], live: null, topPerformers: [], ...over,
} as CricketViewT);

describe("posterVariantFor (EMPTY / other cases first)", () => {
  it("scheduled → upcoming; in_play → live; decided → result", () => {
    expect(posterVariantFor("scheduled", header())).toBe("upcoming");
    expect(posterVariantFor("in_play", LIVE)).toBe("live");
    expect(posterVariantFor("decided", DECIDED)).toBe("result");
  });
  it("status other (abandoned/postponed): result when the document has a status line to print, else upcoming", () => {
    expect(posterVariantFor("abandoned", header({ status: "other", statusLine: { key: "matchCentre.status.abandoned" } }))).toBe("result");
    expect(posterVariantFor("postponed", header({ status: "other", statusLine: null }))).toBe("upcoming");
  });
});

describe("posterCachePolicy — the spec's three values, pinned", () => {
  it("upcoming 60 s, live no-store, result 300 s", () => {
    expect(posterCachePolicy("upcoming")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(posterCachePolicy("live")).toBe("no-store");
    expect(posterCachePolicy("result")).toBe("public, s-maxage=300, stale-while-revalidate=3600");
  });
});

describe("posterFileName", () => {
  it("ASCII slug with the format suffix; diacritics folded; empty names fall back", () => {
    expect(posterFileName("Southend Blue Blazers", "Rochford Ramblers", "feed")).toBe("southend-blue-blazers-v-rochford-ramblers-feed.png");
    expect(posterFileName("Ħal Qormi FC", "Żebbuġ", "story")).toBe("hal-qormi-fc-v-zebbug-story.png");
    expect(posterFileName("", "", "feed")).toBe("match-feed.png");
  });
});

describe("deterministicColour", () => {
  it("is stable per seed, always a palette swatch, and two different seeds can differ (order-differential)", () => {
    expect(deterministicColour("e0")).toBe(deterministicColour("e0"));
    expect(BRAND_PALETTE.map((s) => s.hex)).toContain(deterministicColour("e0"));
    const distinct = new Set(["e0", "e1", "e2", "e3", "e4", "e5"].map(deterministicColour));
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe("matchPosterModel — upcoming", () => {
  it("names, stage line as the display line, format line from the config, kick-off in the VENUE zone and org locale, venue · court, powered footer", () => {
    const m = matchPosterModel(base());
    expect(m.variant).toBe("upcoming");
    expect(m.eyebrow).toBe("DJPL 2026");
    expect(m.displayLine).toBe("League · Round 3");
    expect(m.tiles![0].name).toBe("Southend Blue Blazers Cricket Club 1st XI");
    expect(m.tiles![0].score).toBeNull();
    expect(m.formatLine).toBe("8-over match");
    expect(m.whenLine).toBe(new Intl.DateTimeFormat("en", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date("2026-09-06T13:00:00.000Z")));
    expect(m.whenLine).toContain("14:00"); // 13:00Z is 14:00 in London in September — the VENUE zone, not UTC
    expect(m.whereLine).toBe("Garon Park · Pitch 2");
    expect(m.footer).toEqual({ kind: "powered", text: "Powered by seazn" });
    expect(m.livePill).toBeNull();
    expect(m.performers).toEqual([]);
    expect(m.batters).toEqual([]);
  });
  it("no scheduled_at → the TBD key; no venue → whereLine null; no config → formatLine null (empty cases)", () => {
    const m = matchPosterModel(base({ fixture: { status: "scheduled", scheduledAt: null, venueName: null, courtName: null }, division: { ...base().division, config: null } }));
    expect(m.whenLine).toBe("Time to be confirmed");
    expect(m.whereLine).toBeNull();
    expect(m.formatLine).toBeNull();
  });
  it("the theme is the competition's brand colour through ogTheme (WCAG guarded), the org's when the competition has none", () => {
    expect(matchPosterModel(base()).theme.accent).toBe("#0f766e");
    const orgOnly = matchPosterModel(base({ competition: { name: "X", branding: {} }, org: { name: "O", branded: false, branding: { colors: { primary: "#1d4ed8" } } } }));
    expect(orgOnly.theme.accent).toBe("#1d4ed8");
    const failsGuard = matchPosterModel(base({ competition: { name: "X", branding: { colors: { primary: "#ffe14d" } } } }));
    expect(failsGuard.theme.accent).toBe("#7c3aed"); // violet fallback, same as every OG card
  });
});

describe("matchPosterModel — tiles: crest, colour, monogram", () => {
  it("a fetched badge wins; else the monogram; the tile colour is the team's primary when it passes the guard, else a deterministic palette swatch", () => {
    const m = matchPosterModel(base({ badges: ["data:image/png;base64,AAAA", null], sideColours: ["#be123c", "#ffffff"] }));
    expect(m.tiles![0].badge).toBe("data:image/png;base64,AAAA");
    expect(m.tiles![1].badge).toBeNull();
    expect(m.tiles![1].monogram).toBe("RR");
    expect(m.tiles![0].colour).toBe("#be123c");
    expect(m.tiles![1].colour).toBe(deterministicColour("e1")); // white fails the 3:1 guard → palette
  });
  it("the batting side is emphasised while live; the winner is emphasised on a result", () => {
    const live = matchPosterModel(base({ fixture: { ...base().fixture, status: "in_play" }, header: LIVE }));
    expect(live.tiles!.map((t) => t.emphasis)).toEqual([false, true]);
  });
});

describe("matchPosterModel — live", () => {
  it("LIVE pill, scores + overs, the chase line as the display line, the rate line, batters at the crease, updated HH:MM in the venue zone", () => {
    const cricket = cricketView({
      live: {
        striker: person("Arun Kumar"), nonStriker: person("Dev Patel"), bowler: person("Sam Jones"),
        batters: [
          { person: person("Arun Kumar"), runs: 34, balls: 21, fours: 4, sixes: 1, strikeRate: "161.9", dismissal: { key: "matchCentre.dismissal.not_out" }, notOut: true },
          { person: person("Dev Patel"), runs: 12, balls: 9, fours: 1, sixes: 0, strikeRate: "133.3", dismissal: { key: "matchCentre.dismissal.not_out" }, notOut: true },
        ],
        bowling: [], thisOver: ["1", "4", "W"], partnership: "21 (14)", lastWicket: null,
      },
    });
    const m = matchPosterModel(base({ fixture: { ...base().fixture, status: "in_play" }, header: LIVE, cricket }));
    expect(m.variant).toBe("live");
    expect(m.livePill).toBe("Live");
    expect(m.tiles![1].score).toBe("61/3");
    expect(m.tiles![1].sub).toBe("(4.3)");
    expect(m.displayLine).toBe("Rochford Ramblers need 82 from 21"); // resolved from the document's Msg with the en dictionary
    expect(m.rateLine).toBe("CRR 13.55 · RRR 23.43");
    expect(m.batters).toEqual(["Arun Kumar 34* (21)", "Dev Patel 12* (9)"]);
    expect(m.updatedLine).toBe("Updated 14:32");
    expect(m.whenLine).toBeNull(); // a live poster does not print the kick-off
  });
  it("a masked batter is DROPPED, never printed as a mask (R3) — negative with its positive pair", () => {
    const cricket = cricketView({ live: { striker: null, nonStriker: null, bowler: null, batters: [
      { person: person("Arun K.", true), runs: 34, balls: 21, fours: null, sixes: null, strikeRate: null, dismissal: { key: "matchCentre.dismissal.not_out" }, notOut: true },
      { person: person("Dev Patel"), runs: 12, balls: 9, fours: null, sixes: null, strikeRate: null, dismissal: { key: "matchCentre.dismissal.not_out" }, notOut: true },
    ], bowling: [], thisOver: [], partnership: null, lastWicket: null } });
    const m = matchPosterModel(base({ fixture: { ...base().fixture, status: "in_play" }, header: LIVE, cricket }));
    expect(JSON.stringify(m)).not.toContain("Arun K.");
    expect(m.batters).toEqual(["Dev Patel 12* (9)"]);
  });
});

describe("matchPosterModel — result", () => {
  const performers = [
    { role: "batter" as const, person: person("Arun Kumar"), side: side(0), line: "58 (31)", detail: "SR 187.1" },
    { role: "bowler" as const, person: person("Sam Jones"), side: side(1), line: "3/18", detail: "Econ 4.50" },
    { role: "batter" as const, person: person("Third Man"), side: side(0), line: "20 (10)", detail: null },
  ];
  it("scores under the crests, the result sentence as the display line, at most two top performers, winner emphasised, no live chrome", () => {
    const m = matchPosterModel(base({ fixture: { ...base().fixture, status: "decided" }, header: DECIDED, cricket: cricketView({ topPerformers: performers }) }));
    expect(m.variant).toBe("result");
    expect(m.displayLine).toBe("Southend Blue Blazers Cricket Club 1st XI won by 44 runs");
    expect(m.tiles!.map((t) => t.score)).toEqual(["142/6", "98/9"]);
    expect(m.performers).toEqual(["Arun Kumar · 58 (31)", "Sam Jones · 3/18"]);
    expect(m.performersLabel).toBe("Top performers");
    expect(m.livePill).toBeNull();
    expect(m.rateLine).toBeNull();
    expect(m.updatedLine).toBeNull();
  });
  it("a masked performer is dropped and the NEXT one takes the slot (order-differential); no unmasked performers → no block", () => {
    const masked = [{ ...performers[0]!, person: person("Arun K.", true) }, performers[1]!, performers[2]!];
    const m = matchPosterModel(base({ fixture: { ...base().fixture, status: "decided" }, header: DECIDED, cricket: cricketView({ topPerformers: masked }) }));
    expect(m.performers).toEqual(["Sam Jones · 3/18", "Third Man · 20 (10)"]);
    expect(JSON.stringify(m)).not.toContain("Arun K.");
    const none = matchPosterModel(base({ fixture: { ...base().fixture, status: "decided" }, header: DECIDED, cricket: cricketView({ topPerformers: [{ ...performers[0]!, person: person("X Y", true) }] }) }));
    expect(none.performers).toEqual([]);
    expect(none.performersLabel).toBeNull();
  });
  it("a non-cricket result has no performers and no batters but keeps scores and the result line", () => {
    const m = matchPosterModel(base({ division: { ...base().division, sportKey: "football", config: {} }, fixture: { ...base().fixture, status: "decided" }, header: header({ status: "decided", scoreLines: ["2", "1"], statusLine: { key: "matchCentre.result.plain", params: { side: "Southend Blue Blazers Cricket Club 1st XI" } } }) }));
    expect(m.performers).toEqual([]);
    expect(m.tiles!.map((t) => t.score)).toEqual(["2", "1"]);
  });
});

describe("matchPosterModel — youth rule, sponsor, footer (R3, R6, R8)", () => {
  it("youth + individual/pair entrants: no tiles, no names anywhere, the division as the display line, scores kept", () => {
    const m = matchPosterModel(base({ division: { ...base().division, youth: true, entrantKind: "individual" }, fixture: { ...base().fixture, status: "decided" }, header: DECIDED, cricket: cricketView({ topPerformers: [{ role: "batter", person: person("Arun Kumar"), side: side(0), line: "58 (31)", detail: null }] }) }));
    expect(m.tiles).toBeNull();
    expect(m.youthLine).toBe("Men's T8");
    expect(m.displayLine).toBe("League · Round 3"); // the result sentence names a person → replaced
    expect(JSON.stringify(m)).not.toContain("Arun Kumar");
    expect(JSON.stringify(m)).not.toContain("Rochford Ramblers");
  });
  it("youth + TEAM entrants: teams are named (a team name is not a child's name)", () => {
    const m = matchPosterModel(base({ division: { ...base().division, youth: true, entrantKind: "team" } }));
    expect(m.tiles![1].name).toBe("Rochford Ramblers");
  });
  it("title sponsor strip only when the route passes one; branded org → org footer, else powered", () => {
    expect(matchPosterModel(base()).sponsor).toBeNull();
    const s = matchPosterModel(base({ sponsor: { name: "Acme Roofing", logo: null } }));
    expect(s.sponsor).toEqual({ name: "Acme Roofing", logo: null, label: "Presented by Acme Roofing" });
    expect(matchPosterModel(base({ org: { name: "Southend CC", branded: true, branding: {} } })).footer).toEqual({ kind: "org", text: "Southend CC" });
  });
  it("POSTER_SIZES are the spec's two Instagram sizes", () => {
    expect(POSTER_SIZES).toEqual({ feed: { width: 1080, height: 1350 }, story: { width: 1080, height: 1920 } });
  });
});
```

The `en` dictionary import means Task 7's keys must exist for these to pass — Task 7 can run in the same dispatch as this task (its keys are fixed here by `POSTER_KEYS`), or the implementer adds the English keys in this task and Task 7 completes es/fr/nl.

- [ ] **Step 2: Run — collection failure.**

- [ ] **Step 3: Implement the model half of `match-poster.tsx`**

```tsx
import "server-only";
// Spectator W3 — the match poster (spec §W3; W0 poster option A, crest tiles).
// PURE model + satori card in one file, the post-card.tsx precedent. The model
// decides every string and colour without rendering a pixel; the card is a
// thin flexbox layout over it. One authority per fact (R5): scores, status
// line, chase line, batters and top performers are READ off W1's match-centre
// document, never recomputed here.
import { ogTheme, type OgTheme } from "./model";
import { resolvePublicTheme } from "@/lib/public-theme";
import { BRAND_PALETTE } from "@/lib/brand-palette";
import { crestMonogram } from "@/lib/news-presentation";
import { t } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { MatchCentreHeaderT, CricketViewT, SideT } from "@/server/public-site/match-centre-schema";
import { describeFormat } from "@/server/public-site/describe-format";

export type PosterFormat = "feed" | "story";
export type PosterVariant = "upcoming" | "live" | "result";
export const POSTER_SIZES = {
  feed: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
} as const;
export const POSTER_KEYS = [
  "poster.live", "poster.timeTbd", "poster.updatedAt", "poster.presentedBy", "poster.poweredBy", "poster.vs", "poster.topPerformers",
] as const;

// (MatchPosterInput, PosterTile, MatchPosterModel exactly as in this task's Interfaces block)

export function posterVariantFor(status: string, header: Pick<MatchCentreHeaderT, "status" | "statusLine">): PosterVariant {
  switch (header.status) {
    case "in_play": return "live";
    case "decided": return "result";
    case "other": return header.statusLine ? "result" : "upcoming";   // abandoned / no result reads as a result line (spec §Error and empty states)
    case "scheduled": return "upcoming";
    default: {
      const _exhaustive: never = header.status;
      void _exhaustive;
      return status === "in_play" ? "live" : status === "decided" || status === "finalized" ? "result" : "upcoming";
    }
  }
}

export function posterDisplayLine(variant: PosterVariant, header: Pick<MatchCentreHeaderT, "statusLine">, stageLine: string | null, divisionName: string, dict: Dict, youthHide: boolean): string {
  const fallback = stageLine ?? divisionName;
  if (youthHide) return fallback;                 // a status line can name a person ("Arun K. won by 12 runs")
  if (variant === "upcoming" || !header.statusLine) return fallback;
  return t(dict, header.statusLine.key, header.statusLine.params);
}

export function posterCachePolicy(variant: PosterVariant): string {
  if (variant === "live") return "no-store";
  if (variant === "upcoming") return "public, s-maxage=60, stale-while-revalidate=300";
  return "public, s-maxage=300, stale-while-revalidate=3600";
}

function slug(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[ħĦ]/g, (c) => (c === "Ħ" ? "H" : "h")).replace(/[łŁ]/g, (c) => (c === "Ł" ? "L" : "l")).replace(/[đĐ]/g, (c) => (c === "Đ" ? "D" : "d"))
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
export function posterFileName(home: string, away: string, format: PosterFormat): string {
  const h = slug(home), a = slug(away);
  const stem = h && a ? `${h}-v-${a}` : h || a || "match";
  return `${stem}-${format}.png`;
}

export function deterministicColour(seed: string): string {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;   // FNV-1a
  return BRAND_PALETTE[h % BRAND_PALETTE.length]!.hex;
}

function tileColour(primary: string | null, entrantId: string): string {
  return primary && resolvePublicTheme(primary) ? primary.trim().toLowerCase() : deterministicColour(entrantId);
}

function fmtTime(iso: string, tz: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function matchPosterModel(input: MatchPosterInput): MatchPosterModel {
  const { header, dict, division } = input;
  const variant = posterVariantFor(input.fixture.status, header);
  const youthHide = division.youth && division.entrantKind !== "team";   // fixtureCardModel's rule (og/model.ts:143)
  const theme = ogTheme(input.competition.branding, input.org.branding);
  // The document carries no winner index; on a result the emphasised tile is
  // the side the status line names (W1's `matchCentre.result.*` templates open
  // with `{side}` — if a template does not, compare `statusLine.params.side`
  // to `s.name` instead; pin this against the en dictionary when W1 lands).
  const statusText = header.statusLine ? t(dict, header.statusLine.key, header.statusLine.params) : null;
  const tiles: [PosterTile, PosterTile] | null = youthHide ? null : [0, 1].map((i) => {
    const s: SideT = header.sides[i as 0 | 1];
    const emphasis = variant === "live" ? header.battingIndex === i : variant === "result" ? !!statusText && statusText.startsWith(s.name) : false;
    return {
      name: s.name, short: s.short || s.name, monogram: crestMonogram(s.name), colour: tileColour(input.sideColours[i as 0 | 1], s.entrantId),
      badge: input.badges[i as 0 | 1], score: variant === "upcoming" ? null : header.scoreLines[i as 0 | 1], sub: variant === "upcoming" ? null : header.subLines[i as 0 | 1], emphasis,
    };
  }) as [PosterTile, PosterTile];
  const fmt = describeFormat(division.sportKey, division.config);
  const batters = variant === "live" && !youthHide && input.cricket?.live
    ? input.cricket.live.batters.filter((b) => !b.person.masked).slice(0, 2).map((b) => `${b.person.name} ${b.runs}${b.notOut ? "*" : ""} (${b.balls})`)
    : [];
  const performers = variant === "result" && !youthHide && input.cricket
    ? input.cricket.topPerformers.filter((p) => !p.person.masked).slice(0, 2).map((p) => `${p.person.name} · ${p.line}`)
    : [];
  const when = variant === "upcoming"
    ? input.fixture.scheduledAt
      ? new Intl.DateTimeFormat(input.locale, { timeZone: input.tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(input.fixture.scheduledAt))
      : t(dict, "poster.timeTbd")
    : null;
  const where = [input.fixture.venueName, input.fixture.courtName].filter((x): x is string => !!x).join(" · ") || null;
  return {
    variant, theme, logo: input.logo,
    eyebrow: input.competition.name, stageLine: input.stageLine,
    displayLine: posterDisplayLine(variant, header, input.stageLine, division.name, dict, youthHide),
    livePill: variant === "live" ? t(dict, "poster.live") : null,
    tiles, youthLine: youthHide ? division.name : null, vs: t(dict, "poster.vs"),
    rateLine: variant === "live" ? header.rateLine : null,
    batters, performers, performersLabel: performers.length ? t(dict, "poster.topPerformers") : null,
    formatLine: fmt ? t(dict, fmt.key, fmt.params) : null,
    whenLine: when, whereLine: where,
    updatedLine: variant === "live" ? t(dict, "poster.updatedAt", { time: fmtTime(header.updatedAt, input.tz, input.locale) }) : null,
    sponsor: input.sponsor ? { ...input.sponsor, label: t(dict, "poster.presentedBy", { sponsor: input.sponsor.name }) } : null,
    footer: input.org.branded ? { kind: "org", text: input.org.name } : { kind: "powered", text: t(dict, "poster.poweredBy") },
  };
}
```

- [ ] **Step 4: Run — green.** Mutants to apply and record: (a) drop the `!b.person.masked` filter → both masking tests red; (b) `slice(0, 3)` on performers → the two-performers test reds; (c) format the kick-off with `timeZone: "UTC"` → the venue-zone test reds (13:00 ≠ 14:00); (d) swap the live/result cache strings → the cache test reds; (e) delete the youth branch → the youth test reds.

- [ ] **Step 5: `pnpm exec tsc --noEmit -p tsconfig.json` from `apps/web` — clean.** Then **pin P14**: seed or inspect a club row (`select colors from clubs limit 3` on the `spx` DB, or read the import path in `usecases/imports.ts`) and record the real `colors` shape in the wave report; if it is not `{ primary }`, adjust `tileColour`'s reader and its test in this task, not later.

- [ ] **Step 6: Commit** — "og(poster): pure match-poster model — variant ladder, tiles with crest/colour/monogram, live and result lines from the document, consent drops, youth rule, sponsor and footer, cache policy, file name".

---

### Task 5: The satori card — `MatchPosterCard` (feed and story)

**Files:**
- Modify: `apps/web/src/server/og/match-poster.tsx` (append the card)
- Test: `apps/web/src/server/og/__tests__/match-poster-card.test.tsx`

**Interfaces:**
- Consumes: `MatchPosterModel`, `PosterFormat`, `OgTheme`.
- Produces: `export function MatchPosterCard({ model, format }: { model: MatchPosterModel; format: PosterFormat }): JSX.Element` — root `<div data-format={format} data-variant={model.variant} data-tiles={model.tiles ? "pair" : "youth"} …>`; every `<div>` carries `display: "flex"`; fonts `"Barlow Condensed"` (display) and `"Geist"` (text) by name, matching `POSTER_FONT_FILES`.

- [ ] **Step 1: Write the failing static-markup tests** (`renderToStaticMarkup` — satori is not involved; this pins STRUCTURE and TEXT, the golden the renderer cannot drift from silently):

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchPosterCard, type MatchPosterModel, type PosterTile } from "@/server/og/match-poster";

const theme = { court: "#231738", accent: "#7c3aed", ink: "#f7f5fb", muted: "rgba(247,245,251,0.64)" };
// The card prints `monogram` VERBATIM (it never re-derives it — the model owns
// crestMonogram), so the fixture sets it explicitly: "SB" / "RR".
const tile = (name: string, over: Partial<PosterTile> = {}): PosterTile => ({
  name, short: name, monogram: name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase(), colour: "#0f766e", badge: null, score: null, sub: null, emphasis: false, ...over,
});
const upcoming: MatchPosterModel = {
  variant: "upcoming", theme, logo: null, eyebrow: "DJPL 2026", stageLine: "League · Round 3", displayLine: "League · Round 3", livePill: null,
  tiles: [tile("Southend Blue Blazers Cricket Club 1st XI"), tile("Rochford Ramblers")], youthLine: null, vs: "V",
  rateLine: null, batters: [], performers: [], performersLabel: null, formatLine: "8-over match", whenLine: "Sat 6 Sep, 14:00", whereLine: "Garon Park · Pitch 2", updatedLine: null,
  sponsor: null, footer: { kind: "powered", text: "Powered by seazn" },
};
const result: MatchPosterModel = {
  ...upcoming, variant: "result", displayLine: "Southend Blue Blazers Cricket Club 1st XI won by 44 runs",
  tiles: [tile("Southend Blue Blazers Cricket Club 1st XI", { score: "142/6", sub: "(8.0)", emphasis: true, badge: "data:image/png;base64,AAAA" }), tile("Rochford Ramblers", { score: "98/9", sub: "(8.0)" })],
  performers: ["Arun Kumar · 58 (31)", "Sam Jones · 3/18"], performersLabel: "Top performers", whenLine: null,
  sponsor: { name: "Acme Roofing", logo: "data:image/png;base64,BBBB", label: "Presented by Acme Roofing" }, footer: { kind: "org", text: "Southend CC" },
};
const live: MatchPosterModel = {
  ...upcoming, variant: "live", livePill: "Live", displayLine: "Rochford Ramblers need 82 from 21", rateLine: "CRR 13.55 · RRR 23.43",
  tiles: [tile("Southend Blue Blazers Cricket Club 1st XI", { score: "142/6", sub: "(8.0)" }), tile("Rochford Ramblers", { score: "61/3", sub: "(4.3)", emphasis: true })],
  batters: ["Arun Kumar 34* (21)", "Dev Patel 12* (9)"], whenLine: null, updatedLine: "Updated 14:32",
};
const html = (m: MatchPosterModel, format: "feed" | "story" = "feed") => renderToStaticMarkup(<MatchPosterCard model={m} format={format} />);
const order = (h: string, ...needles: string[]) => needles.map((n) => { const i = h.indexOf(n); expect(i, `"${n}" present`).toBeGreaterThan(-1); return i; });

describe("MatchPosterCard — satori constraints", () => {
  it("every div declares display:flex (satori renders anything else as nothing) and no grid is used", () => {
    for (const m of [upcoming, live, result]) for (const f of ["feed", "story"] as const) {
      const h = html(m, f);
      expect((h.match(/<div/g) ?? []).length).toBe((h.match(/display:flex/g) ?? []).length);
      expect(h).not.toContain("display:grid");
    }
  });
  it("uses the two pinned families by name, and the story format consumes its own rhythm", () => {
    const feed = html(upcoming, "feed"), story = html(upcoming, "story");
    expect(feed).toContain("font-family:Barlow Condensed");
    expect(feed).toContain("font-family:Geist");
    expect(feed).toContain('data-format="feed"');
    expect(story).toContain('data-format="story"');
    expect(feed).not.toBe(story);
  });
});

describe("MatchPosterCard — anatomy (spec §W3 items 1–6), in reading order", () => {
  it("upcoming: eyebrow → stage line → both names → V → format → when → where → footer; no scores", () => {
    const h = html(upcoming);
    const idx = order(h, "DJPL 2026", "Southend Blue Blazers Cricket Club 1st XI", ">V<", "Rochford Ramblers", "8-over match", "Sat 6 Sep, 14:00", "Garon Park · Pitch 2", "Powered by seazn");
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(h).not.toContain("142/6");
    expect(h).toContain('data-tiles="pair"');
    expect(h).not.toContain("<img");   // no badge → monogram tiles
    expect(h).toContain(">SB<");       // the fixture's monogram, printed verbatim
    expect(h).toContain(">RR<");
  });
  it("result: scores and overs under the crests, the result sentence as the display line, performers with their label, sponsor strip, org footer, a badge img when present", () => {
    const h = html(result);
    order(h, "142/6", "(8.0)", "98/9", "Southend Blue Blazers Cricket Club 1st XI won by 44 runs", "Top performers", "Arun Kumar · 58 (31)", "Sam Jones · 3/18", "Presented by Acme Roofing", "Southend CC");
    expect((h.match(/<img/g) ?? []).length).toBe(2);   // one badge + one sponsor logo
    expect(h).toContain('src="data:image/png;base64,AAAA"');
    expect(h).not.toContain("Powered by seazn");
    expect(h).toContain('data-emphasis="true"');
  });
  it("live: LIVE pill, chase line, rate line, batters, updated line; no kick-off line", () => {
    const h = html(live);
    order(h, "Live", "61/3", "(4.3)", "Rochford Ramblers need 82 from 21", "CRR 13.55 · RRR 23.43", "Arun Kumar 34* (21)", "Dev Patel 12* (9)", "Updated 14:32");
    expect(h).not.toContain("Sat 6 Sep");
  });
  it("youth (tiles null): the division line, no name pills, no img, scores still print", () => {
    const h = html({ ...result, tiles: null, youthLine: "Men's U13", displayLine: "League · Round 3", performers: [], performersLabel: null, sponsor: null });
    expect(h).toContain('data-tiles="youth"');
    expect(h).toContain("Men's U13");
    expect(h).not.toContain("Rochford Ramblers");
    expect(h).not.toContain("<img");
  });
  it("EMPTY lines render nothing: null format/where/when leave no empty pill", () => {
    const h = html({ ...upcoming, formatLine: null, whereLine: null, whenLine: null });
    expect((h.match(/data-pill/g) ?? []).length).toBe(0);
    const full = html(upcoming);
    expect((full.match(/data-pill/g) ?? []).length).toBe(3);   // positive pair
  });
});
```

(The monogram assertion prints exactly what the model passed — set `monogram` explicitly in the fixture if `crestMonogram` semantics differ; the CARD never re-derives it.)

- [ ] **Step 2: Run — failures** (`MatchPosterCard` not exported).

- [ ] **Step 3: Implement the card** (append to `match-poster.tsx`). Layout constants per format, then one flex column. Keep every `<div>` `display: "flex"`; attributes `data-*` are ignored by satori and exist for the static tests.

```tsx
const R = {
  feed:  { pad: 72, logo: 72, eyebrow: 30, stage: 30, display: 78, tile: 340, badge: 232, mono: 140, name: 32, score: 92, sub: 30, line: 32, pill: 28, footer: 30, gap: 28 },
  story: { pad: 84, logo: 84, eyebrow: 34, stage: 34, display: 92, tile: 400, badge: 272, mono: 164, name: 36, score: 108, sub: 34, line: 36, pill: 32, footer: 34, gap: 44 },
} as const;
const DISPLAY = "Barlow Condensed";
const TEXT = "Geist";

function Tile({ t, r, theme }: { t: PosterTile; r: (typeof R)[PosterFormat]; theme: OgTheme }) {
  return (
    <div data-emphasis={t.emphasis ? "true" : "false"} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18, width: r.tile + 60 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: r.tile, height: r.tile, borderRadius: 48, background: t.colour, border: t.emphasis ? `6px solid ${theme.ink}` : "6px solid rgba(255,255,255,0.12)" }}>
        {t.badge ? (
          // eslint-disable-next-line @next/next/no-img-element -- satori
          <img src={t.badge} alt="" width={r.badge} height={r.badge} style={{ objectFit: "contain" }} />
        ) : (
          <div style={{ display: "flex", fontFamily: DISPLAY, fontWeight: 700, fontSize: r.mono, color: theme.ink }}>{t.monogram}</div>
        )}
      </div>
      <div style={{ display: "flex", maxWidth: r.tile + 60, borderRadius: 999, background: "rgba(255,255,255,0.12)", padding: "10px 22px", fontFamily: TEXT, fontWeight: 700, fontSize: r.name, textAlign: "center", lineHeight: 1.15, lineClamp: 2 }}>
        {t.name}
      </div>
      {t.score ? (
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, fontFamily: DISPLAY, fontWeight: 700, fontSize: r.score, lineHeight: 1, fontVariantNumeric: "tabular-nums", color: theme.ink }}>
          {t.score}
          {t.sub ? <div style={{ display: "flex", fontFamily: TEXT, fontWeight: 400, fontSize: r.sub, color: theme.muted }}>{t.sub}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function Pill({ text, r, theme }: { text: string; r: (typeof R)[PosterFormat]; theme: OgTheme }) {
  return (
    <div data-pill="" style={{ display: "flex", borderRadius: 999, border: `3px solid ${theme.accent}`, padding: "10px 24px", fontFamily: TEXT, fontWeight: 400, fontSize: r.pill, color: theme.ink }}>
      {text}
    </div>
  );
}

export function MatchPosterCard({ model, format }: { model: MatchPosterModel; format: PosterFormat }) {
  const r = R[format];
  const { theme } = model;
  return (
    <div data-format={format} data-variant={model.variant} data-tiles={model.tiles ? "pair" : "youth"}
      style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", padding: r.pad, background: theme.court, color: theme.ink, fontFamily: TEXT }}>
      {/* 1. masthead: competition/org logo + eyebrow; 2. stage line */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        {model.logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- satori
          <img src={model.logo} alt="" width={r.logo} height={r.logo} style={{ borderRadius: 16, background: "#ffffff", objectFit: "contain" }} />
        ) : null}
        <div style={{ display: "flex", fontFamily: TEXT, fontWeight: 700, fontSize: r.eyebrow, letterSpacing: 6, textTransform: "uppercase", color: theme.muted }}>{model.eyebrow}</div>
        {model.stageLine && model.displayLine !== model.stageLine ? (
          <div style={{ display: "flex", fontFamily: TEXT, fontWeight: 400, fontSize: r.stage, color: theme.muted }}>{model.stageLine}</div>
        ) : null}
        {model.livePill ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, borderRadius: 999, border: `3px solid ${theme.accent}`, padding: "8px 22px", fontFamily: TEXT, fontWeight: 700, fontSize: r.pill, letterSpacing: 4, textTransform: "uppercase" }}>
            <div style={{ display: "flex", width: 14, height: 14, borderRadius: 999, background: "#34d399" }} />
            {model.livePill}
          </div>
        ) : null}
        <div style={{ display: "flex", fontFamily: DISPLAY, fontWeight: 700, fontSize: r.display, lineHeight: 1.02, textAlign: "center", textTransform: "uppercase", lineClamp: 2 }}>{model.displayLine}</div>
      </div>
      {/* 3. crests with the V mark, name pills, scores */}
      {model.tiles ? (
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <Tile t={model.tiles[0]} r={r} theme={theme} />
          <div style={{ display: "flex", alignSelf: "center", fontFamily: DISPLAY, fontWeight: 600, fontSize: 72, color: theme.muted }}>{model.vs}</div>
          <Tile t={model.tiles[1]} r={r} theme={theme} />
        </div>
      ) : (
        <div style={{ display: "flex", justifyContent: "center", fontFamily: DISPLAY, fontWeight: 600, fontSize: r.display * 0.7, textTransform: "uppercase", color: theme.ink }}>{model.youthLine}</div>
      )}
      {/* live / result detail */}
      {model.rateLine || model.batters.length || model.performers.length ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          {model.rateLine ? <div style={{ display: "flex", fontSize: r.line, color: theme.muted, fontVariantNumeric: "tabular-nums" }}>{model.rateLine}</div> : null}
          {model.batters.map((b) => <div key={b} style={{ display: "flex", fontSize: r.line, fontVariantNumeric: "tabular-nums" }}>{b}</div>)}
          {model.performersLabel ? <div style={{ display: "flex", fontSize: r.pill, letterSpacing: 4, textTransform: "uppercase", color: theme.accent, fontWeight: 700 }}>{model.performersLabel}</div> : null}
          {model.performers.map((p) => <div key={p} style={{ display: "flex", fontSize: r.line }}>{p}</div>)}
        </div>
      ) : null}
      {/* 4–5. format, date · time, venue pills */}
      {model.formatLine || model.whenLine || model.whereLine ? (
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 14 }}>
          {model.formatLine ? <Pill text={model.formatLine} r={r} theme={theme} /> : null}
          {model.whenLine ? <Pill text={model.whenLine} r={r} theme={theme} /> : null}
          {model.whereLine ? <Pill text={model.whereLine} r={r} theme={theme} /> : null}
        </div>
      ) : null}
      {/* 6. footer: title sponsor strip, then powered / org */}
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {model.sponsor ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 18, fontSize: r.pill, color: theme.muted }}>
            {model.sponsor.logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- satori
              <img src={model.sponsor.logo} alt="" width={r.logo} height={r.logo} style={{ borderRadius: 12, background: "#ffffff", objectFit: "contain" }} />
            ) : null}
            {model.sponsor.label}
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: r.footer }}>
          <div style={{ display: "flex", fontWeight: 700 }}>{model.footer.text}</div>
          {model.updatedLine ? <div style={{ display: "flex", color: theme.muted }}>{model.updatedLine}</div> : <div style={{ display: "flex", fontWeight: 700, color: theme.muted }}>seazn.club</div>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run — green.** Then run the Task 1 contract test file again with THIS card (temporarily swap the element in a scratch copy, or add a third case rendering `<MatchPosterCard model={result} format="story" />` to `image-response-contract.test.tsx` and keep it) — the story render must still decode to 1080×1920 and finish under 3 s with three data-URI images. Mutant: replace one inner `display: "flex"` with `"block"` → the flex-guard test reds.

- [ ] **Step 5: Commit** — "og(poster): satori card for feed and story — masthead, display line, crest tiles with V, name pills, scores, live/result detail, info pills, sponsor strip, footer".

---

### Task 6: The route — `poster.png?format=feed|story`

**Files:**
- Create: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/poster.png/route.tsx`
- Test: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/poster.png/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `getPublicFixture(orgSlug, compSlug, divSlug, fixtureId)` → `{ org, competition, division, fixture, entrantNames, realtime, matchCentre }` (P1); `getPublicDivision(...)` → `{ stages, fixtures, entrants, tz }` (P13); `hasFeature(orgId, "sponsors.tiers", competitionId)` (`@/lib/entitlements`); `resolveSponsors` (P12); `resolveEntrantBadge` (`@/lib/entrant-badge`); `roundRoleFor`/`roundRoleLabel` + `msgFor` (P13); `getDictionary(locale, "public")` (`@/lib/i18n:77`), `toLocale` (`@/lib/i18n-constants:42`); Tasks 1, 2, 4, 5.
- Produces: `GET(req, ctx): Promise<Response>` — `image/png`; headers `Cache-Control` (Task 4's policy), `Content-Disposition: inline; filename="<slug>-<format>.png"`, `X-Poster-Variant`, `X-Poster-Fonts` (count of loaded faces); `404` for an unknown/private fixture; `503 no-store` when the document is absent (a build where W1 Task 9 has not landed must not 500 or serve a wrong poster).

- [ ] **Step 1: Write the failing route test** (mocks follow `poster.pdf/__tests__/route.test.ts:32-47`: module-level `vi.fn()`s, `mockReset` in `beforeEach`):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/dictionaries/en/public.json";
import { pngSize } from "@/lib/png-size";

const getPublicFixture = vi.fn();
const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicFixture: (...a: unknown[]) => getPublicFixture(...a),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
const hasFeature = vi.fn();
vi.mock("@/lib/entitlements", () => ({ hasFeature: (...a: unknown[]) => hasFeature(...a) }));
const resolveSponsors = vi.fn();
vi.mock("@/server/usecases/sponsors", () => ({ resolveSponsors: (...a: unknown[]) => resolveSponsors(...a) }));
const fetchImageDataUri = vi.fn();
vi.mock("@/server/og/poster-image", async (orig) => ({
  ...(await orig<typeof import("@/server/og/poster-image")>()),
  fetchImageDataUri: (...a: unknown[]) => fetchImageDataUri(...a),
}));
vi.mock("@/lib/i18n", () => ({ getDictionary: async () => en }));

import { GET } from "../route";

const ctx = (fixtureId = "11111111-1111-4111-8111-111111111111") => ({ params: Promise.resolve({ orgSlug: "o", competitionSlug: "c", divisionSlug: "d", fixtureId }) });
const req = (qs = "") => new Request(`https://seazn.club/shared/o/c/d/fixtures/x/poster.png${qs}`);
const side = (i: 0 | 1) => ({ entrantId: `e${i}`, name: i ? "Rochford Ramblers" : "Southend Blue Blazers", short: i ? "ROC" : "SBB", colour: null, badgeUrl: null });
const doc = (status: "scheduled" | "in_play" | "decided", extra: Record<string, unknown> = {}) => ({
  fixtureId: "f1", sportKey: "cricket",
  header: { live: status === "in_play", status, sides: [side(0), side(1)], scoreLines: status === "scheduled" ? [null, null] : ["142/6", "98/9"], subLines: status === "scheduled" ? [null, null] : ["(8.0)", "(8.0)"], battingIndex: status === "in_play" ? 1 : null,
    statusLine: status === "decided" ? { key: "matchCentre.result.runs", params: { side: "Southend Blue Blazers", runs: 44 } } : status === "in_play" ? { key: "matchCentre.chase.need", params: { side: "Rochford Ramblers", runs: 45, balls: 21 } } : null,
    rateLine: status === "in_play" ? "CRR 7.84 · RRR 6.00" : null, updatedAt: "2026-09-06T13:32:10.000Z" },
  tabs: ["summary", "info"], cricket: null, timeline: null, sets: null,
  info: { rows: [], calendarHref: null, divisionHref: "/shared/o/c/d", competitionHref: "/shared/o/c" }, derivedComplete: true, ...extra,
});
const fixtureData = (status: "scheduled" | "in_play" | "decided", over: Record<string, unknown> = {}) => ({
  org: { id: "o1", name: "Southend CC", slug: "o", branded: false, branding: {}, logo: null, about: null, default_locale: "en", card_payments: false },
  competition: { id: "c1", org_id: "o1", name: "DJPL 2026", slug: "c", description: null, starts_on: null, ends_on: null, branding: { colors: { primary: "#0f766e" } }, status: "active", visibility: "public" },
  division: { id: "d1", competition_id: "c1", name: "Men's T8", slug: "d", description: null, sport_key: "cricket", variant_key: "t20", status: "active", module_version: "1", tiebreakers: null, sport_name: "Cricket", entrant_count: 2, youth: false, player_name_display: null, config: { ballsPerInnings: 48, ballsPerOver: 6, playersPerSide: 8 } },
  fixture: { id: "f1", division_id: "d1", stage_id: "s1", pool_id: null, round_no: 3, seq_in_round: 1, home_entrant_id: "e0", away_entrant_id: "e1", home_slot_label: null, away_slot_label: null, scheduled_at: "2026-09-06T13:00:00.000Z", venue: null, court_label: null, venue_name: "Garon Park", court_name: null, status, outcome: null, summary: null, last_seq: 10, lane: null, is_final: false, third_place: false, conditional: false },
  entrantNames: { e0: "Southend Blue Blazers", e1: "Rochford Ramblers" },
  realtime: false,
  matchCentre: doc(status),
  ...over,
});
const divisionData = () => ({
  org: fixtureData("scheduled").org, competition: fixtureData("scheduled").competition, division: fixtureData("scheduled").division,
  stages: [{ id: "s1", division_id: "d1", seq: 1, kind: "league", name: "League", status: "active" }], pools: [],
  fixtures: [fixtureData("scheduled").fixture], standings: [],
  entrants: [
    { id: "e0", division_id: "d1", kind: "team", display_name: "Southend Blue Blazers", seed: null, status: "active", members: [], badge_url: "https://flags.example/sbb.png", team_display: null },
    { id: "e1", division_id: "d1", kind: "team", display_name: "Rochford Ramblers", seed: null, status: "active", members: [], badge_url: null, team_display: { club_id: "k1", club_name: "Rochford", logo_path: "orgs/o1/clubs/roc.png", colors: { primary: "#be123c" } } },
  ],
  tz: "Europe/London",
});

beforeEach(() => {
  getPublicFixture.mockReset(); getPublicDivision.mockReset(); hasFeature.mockReset(); resolveSponsors.mockReset(); fetchImageDataUri.mockReset();
  hasFeature.mockResolvedValue(false);
  fetchImageDataUri.mockResolvedValue(null);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://sb.example");
});

describe("poster.png route", () => {
  it("404 for an unknown or private fixture (the page's own rule), without touching the division", async () => {
    getPublicFixture.mockResolvedValue(null);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
    expect(getPublicDivision).not.toHaveBeenCalled();
  });
  it("503 no-store when the document is absent (W1 Task 9 not wired) — never a 500, never a wrong poster", async () => {
    getPublicFixture.mockResolvedValue(fixtureData("decided", { matchCentre: undefined }));
    getPublicDivision.mockResolvedValue(divisionData());
    const res = await GET(req(), ctx());
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("feed by default (and for an unknown format); story on ?format=story — exact dimensions, image/png, four fonts", async () => {
    getPublicFixture.mockResolvedValue(fixtureData("scheduled"));
    getPublicDivision.mockResolvedValue(divisionData());
    for (const [qs, w, h] of [["", 1080, 1350], ["?format=bogus", 1080, 1350], ["?format=story", 1080, 1920]] as const) {
      const res = await GET(req(qs), ctx());
      expect(res.status, qs).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-poster-fonts")).toBe("4");
      expect(pngSize(new Uint8Array(await res.arrayBuffer())), qs).toEqual({ width: w, height: h });
    }
  });
  it("cache policy and variant header follow the document's status", async () => {
    getPublicDivision.mockResolvedValue(divisionData());
    getPublicFixture.mockResolvedValue(fixtureData("scheduled"));
    let res = await GET(req(), ctx());
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(res.headers.get("x-poster-variant")).toBe("upcoming");
    getPublicFixture.mockResolvedValue(fixtureData("in_play"));
    res = await GET(req(), ctx());
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-poster-variant")).toBe("live");
    getPublicFixture.mockResolvedValue(fixtureData("decided"));
    res = await GET(req(), ctx());
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=3600");
    expect(res.headers.get("x-poster-variant")).toBe("result");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="southend-blue-blazers-v-rochford-ramblers-feed.png"');
  });
  it("crests are fetched through resolveEntrantBadge for BOTH sources — the entrant's badge_url and the team/club logo_path", async () => {
    getPublicFixture.mockResolvedValue(fixtureData("scheduled"));
    getPublicDivision.mockResolvedValue(divisionData());
    await GET(req(), ctx());
    const urls = fetchImageDataUri.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://flags.example/sbb.png");
    expect(urls).toContain("https://sb.example/storage/v1/object/public/assets/orgs/o1/clubs/roc.png");
  });
  it("the title sponsor is looked up ONLY behind the existing sponsors.tiers gate (R6) — negative and positive pair", async () => {
    getPublicFixture.mockResolvedValue(fixtureData("scheduled"));
    getPublicDivision.mockResolvedValue(divisionData());
    await GET(req(), ctx());
    expect(resolveSponsors).not.toHaveBeenCalled();
    hasFeature.mockResolvedValue(true);
    resolveSponsors.mockResolvedValue([{ id: "sp1", name: "Acme Roofing", url: null, logo: "orgs/o1/sponsors/acme.png", tier: "title" }]);
    await GET(req(), ctx());
    expect(hasFeature).toHaveBeenCalledWith("o1", "sponsors.tiers", "c1");
    expect(resolveSponsors).toHaveBeenCalledWith("o1", "c1", { tiered: true });
    expect(fetchImageDataUri.mock.calls.map((c) => c[0])).toContain("https://sb.example/storage/v1/object/public/assets/orgs/o1/sponsors/acme.png");
  });
});
```

If Task 1 recorded outcome (b), replace the two `pngSize(...)` assertions with a `vi.mock("next/og", …)` that captures the options and asserts `{ width, height, fonts.length === 4 }` plus the header map — and say so in the test header comment.

- [ ] **Step 2: Run — collection failure.**

- [ ] **Step 3: Implement the route**

```tsx
// Spectator W3 — the per-match poster (spec §W3). One route, three variants
// (upcoming / live / result) by the document's status, two Instagram sizes by
// ?format. Rendered with next/og ImageResponse exactly as
// news/[postSlug]/story.png is; unlike that route this one reads the request
// (the ?format query), so it is dynamic and sets its own Cache-Control per
// variant rather than relying on `revalidate`. No `contentType` export — a
// Route Handler convention Next rejects (see story.png/route.tsx:15-17).
import { ImageResponse } from "next/og";
import { getPublicDivision, getPublicFixture, type PublicEntrant } from "@/server/public-site/data";
import { hasFeature } from "@/lib/entitlements";
import { resolveSponsors } from "@/server/usecases/sponsors";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import { getDictionary } from "@/lib/i18n";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { roundRoleFor, roundRoleLabel } from "@/lib/round-role-label";
import { loadPosterFonts } from "@/server/og/poster-fonts";
import { fetchImageDataUri, toAssetUrl } from "@/server/og/poster-image";
import { MatchPosterCard, matchPosterModel, posterCachePolicy, posterFileName, POSTER_SIZES, type PosterFormat } from "@/server/og/match-poster";

export const dynamic = "force-dynamic";

const TILE_PX = 480;   // 2× the 232/272 px badge box — crisp when Instagram re-samples
const LOGO_PX = 168;

type Ctx = { params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string; fixtureId: string }> };

function primaryColour(colors: unknown): string | null {
  if (typeof colors !== "object" || colors === null) return null;
  const p = (colors as { primary?: unknown }).primary;
  return typeof p === "string" ? p : null;
}

export async function GET(req: Request, { params }: Ctx) {
  const { orgSlug, competitionSlug, divisionSlug, fixtureId } = await params;
  const format: PosterFormat = new URL(req.url).searchParams.get("format") === "story" ? "story" : "feed";

  const data = await getPublicFixture(orgSlug, competitionSlug, divisionSlug, fixtureId);
  if (!data) return new Response("not found", { status: 404 });
  const doc = data.matchCentre;
  if (!doc) return new Response("poster unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  const div = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!div) return new Response("not found", { status: 404 });

  const { org, competition, division, fixture } = data;
  const locale = toLocale(org.default_locale);
  const dict = await getDictionary(locale, "public");
  const msg = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) => msgFor(locale, k, v);

  const stage = div.stages.find((s) => s.id === fixture.stage_id) ?? null;
  const roundLabel = stage
    ? roundRoleLabel(msg, roundRoleFor(div.fixtures, { round_no: fixture.round_no, lane: fixture.lane ?? null, is_final: fixture.is_final ?? false, third_place: fixture.third_place ?? false, conditional: fixture.conditional ?? false }, stage.kind))
    : null;
  const stageLine = stage ? (roundLabel ? `${stage.name} · ${roundLabel}` : stage.name) : null;

  const byId = new Map<string, PublicEntrant>(div.entrants.map((e) => [e.id, e]));
  const entrants = doc.header.sides.map((s) => byId.get(s.entrantId) ?? null) as [PublicEntrant | null, PublicEntrant | null];
  const badgeUrl = (e: PublicEntrant | null) => (e ? resolveEntrantBadge({ badge_url: e.badge_url, team_logo_path: e.team_display?.logo_path }) : null);

  const tiered = await hasFeature(org.id, "sponsors.tiers", competition.id);
  const title = tiered ? ((await resolveSponsors(org.id, competition.id, { tiered })).find((s) => s.tier === "title") ?? null) : null;
  const compLogo = toAssetUrl((competition.branding as { logo_path?: unknown }).logo_path as string | undefined);

  const [fonts, badge0, badge1, logo, sponsorLogo] = await Promise.all([
    loadPosterFonts(),
    fetchImageDataUri(badgeUrl(entrants[0]), { size: TILE_PX }),
    fetchImageDataUri(badgeUrl(entrants[1]), { size: TILE_PX }),
    fetchImageDataUri(compLogo ?? org.logo, { size: LOGO_PX }),
    title ? fetchImageDataUri(toAssetUrl(title.logo), { size: LOGO_PX }) : Promise.resolve(null),
  ]);

  const model = matchPosterModel({
    org: { name: org.name, branded: org.branded, branding: org.branding },
    competition: { name: competition.name, branding: competition.branding },
    division: { name: division.name, youth: division.youth ?? false, entrantKind: entrants[0]?.kind ?? entrants[1]?.kind ?? null, sportKey: division.sport_key, config: division.config ?? null },
    fixture: { status: fixture.status, scheduledAt: fixture.scheduled_at, venueName: fixture.venue_name, courtName: fixture.court_name },
    stageLine, header: doc.header, cricket: doc.cricket, logo,
    badges: [badge0, badge1],
    sideColours: [primaryColour(entrants[0]?.team_display?.colors), primaryColour(entrants[1]?.team_display?.colors)],
    sponsor: title ? { name: title.name, logo: sponsorLogo } : null,
    tz: div.tz, locale, dict, now: new Date(),
  });

  return new ImageResponse(<MatchPosterCard model={model} format={format} />, {
    ...POSTER_SIZES[format],
    fonts,
    headers: {
      "Cache-Control": posterCachePolicy(model.variant),
      "Content-Disposition": `inline; filename="${posterFileName(doc.header.sides[0].name, doc.header.sides[1].name, format)}"`,
      "X-Poster-Variant": model.variant,
      "X-Poster-Fonts": String(fonts.length),
    },
  });
}
```

- [ ] **Step 4: Run — green (6 tests).** `pnpm exec tsc --noEmit -p tsconfig.json` from `apps/web` — clean (this is where `data.matchCentre` and `division.config` must exist on the types: P1, P5).

- [ ] **Step 5: Prove the prod build serves it** — from the worktree: `seazn-env up --label spx --server` (per `~/.claude/skills/seazn-local-env/SKILL.md`), `eval "$(seazn-env env --label spx)"`, seed one public cricket fixture through the API (the W0 harness's `seed.json` path or the walkthrough's `beforeAll`), then `curl -sS -o /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/6262000e-0d12-4731-97e2-7a60369846eb/scratchpad/poster.png -D - "$SMOKE_BASE/shared/<org>/<comp>/<div>/fixtures/<id>/poster.png?format=story"` → headers show `content-type: image/png`, `x-poster-fonts: 4`, `x-poster-variant`; `node -e 'const b=require("fs").readFileSync(process.argv[1]);console.log(b.readUInt32BE(16),b.readUInt32BE(20))' …/poster.png` → `1080 1920`. Open the PNG and LOOK at it (R11 starts here — a wrong font renders, it does not error). If `x-poster-fonts` is absent or the route 500s with ENOENT, the standalone cwd premise (P9) is false: move the fonts to `apps/web/src/server/og/fonts/` and load them with `readFile(new URL("./fonts/<file>", import.meta.url))` so output-file tracing carries them; record the finding. Take the env down after.

- [ ] **Step 6: Commit** — "public(fixture): poster.png route — feed/story from the match-centre document, crests via resolveEntrantBadge, title sponsor behind sponsors.tiers, per-variant Cache-Control, filename, variant and font headers".

---

### Task 7: Dictionaries — `poster.*` (and `format.*` if W3 owns them) in four locales, generated keys, coverage test

**Files:**
- Modify: `apps/web/src/dictionaries/en/public.json`, `es/public.json`, `fr/public.json`, `nl/public.json`
- Regenerate: `apps/web/src/lib/i18n-keys.ts` via `npm run i18n:gen-keys` (never by hand)
- Test: `apps/web/src/server/og/__tests__/poster-dictionary.test.ts`

- [ ] **Step 1: Failing coverage test — every key the model and the control emit exists in all four locales with its params**

```ts
import { describe, it, expect } from "vitest";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import { POSTER_KEYS } from "@/server/og/match-poster";
import { POSTER_UI_KEYS } from "@/components/public-site/match-centre/poster-download";

const FORMAT_KEYS = ["format.cricket.overs", "format.football.minutes", "format.sets.bestOf"] as const;   // emitted by describeFormat (W2/W3 Task 3)
const PARAMS: Record<string, string[]> = {
  "poster.updatedAt": ["{time}"], "poster.presentedBy": ["{sponsor}"],
  "format.cricket.overs": ["{overs}"], "format.football.minutes": ["{minutes}"], "format.sets.bestOf": ["{n}"],
};
const ALL = [...POSTER_KEYS, ...POSTER_UI_KEYS, ...FORMAT_KEYS];

describe("poster dictionary coverage (R2 — four locales, keys derived from the code, not typed here)", () => {
  for (const [locale, dict] of Object.entries({ en, es, fr, nl }) as [string, Record<string, unknown>][]) {
    it(`${locale} has every poster key, non-empty, with every placeholder the template needs`, () => {
      for (const k of ALL) {
        expect(dict, `${locale}: ${k}`).toHaveProperty(k);
        const v = dict[k];
        expect(typeof v === "string" && v.trim().length > 0, `${locale}: ${k} empty`).toBe(true);
        for (const p of PARAMS[k] ?? []) expect(v as string, `${locale}: ${k} lacks ${p}`).toContain(p);
      }
    });
  }
  it("the four locales carry the SAME key set (a key added to en alone is the usual slip)", () => {
    const keys = (d: Record<string, unknown>) => Object.keys(d).filter((k) => k.startsWith("poster.") || k.startsWith("format.")).sort();
    expect(keys(es)).toEqual(keys(en));
    expect(keys(fr)).toEqual(keys(en));
    expect(keys(nl)).toEqual(keys(en));
  });
});
```

- [ ] **Step 2: Run — fails listing the missing keys** (and `POSTER_UI_KEYS` missing until Task 8 — implement Task 8's `poster-download.tsx` export first if this task runs before it, or run the two in one dispatch).

- [ ] **Step 3: Add the keys** (bare, alphabetical within the `poster.` block, after the existing `news.*` block — `public.json` is wave-ordered, not alphabetical; add the block where it reads best and keep the same position in all four files). English:

```json
"poster.download": "Download poster",
"poster.formats.label": "Poster formats",
"poster.format.feed": "Feed · 4:5",
"poster.format.story": "Story · 9:16",
"poster.share": "Share image",
"poster.live": "Live",
"poster.timeTbd": "Time to be confirmed",
"poster.updatedAt": "Updated {time}",
"poster.presentedBy": "Presented by {sponsor}",
"poster.poweredBy": "Powered by seazn",
"poster.vs": "V",
"poster.topPerformers": "Top performers",
"format.cricket.overs": "{overs}-over match",
"format.football.minutes": "2 × {minutes} min",
"format.sets.bestOf": "Best of {n}"
```

Spanish: `"Descargar cartel"`, `"Formatos del cartel"`, `"Feed · 4:5"`, `"Story · 9:16"`, `"Compartir imagen"`, `"En directo"`, `"Hora por confirmar"`, `"Actualizado {time}"`, `"Presentado por {sponsor}"`, `"Con la tecnología de seazn"`, `"V"`, `"Destacados"`, `"Partido de {overs} overs"`, `"2 × {minutes} min"`, `"Al mejor de {n}"`.
French: `"Télécharger l'affiche"`, `"Formats de l'affiche"`, `"Feed · 4:5"`, `"Story · 9:16"`, `"Partager l'image"`, `"En direct"`, `"Heure à confirmer"`, `"Mis à jour {time}"`, `"Présenté par {sponsor}"`, `"Propulsé par seazn"`, `"V"`, `"Joueurs en vue"`, `"Match de {overs} overs"`, `"2 × {minutes} min"`, `"Au meilleur des {n}"`.
Dutch: `"Poster downloaden"`, `"Posterformaten"`, `"Feed · 4:5"`, `"Story · 9:16"`, `"Afbeelding delen"`, `"Live"`, `"Tijd nog te bevestigen"`, `"Bijgewerkt {time}"`, `"Gepresenteerd door {sponsor}"`, `"Mogelijk gemaakt door seazn"`, `"V"`, `"Uitblinkers"`, `"Wedstrijd van {overs} overs"`, `"2 × {minutes} min"`, `"Best of {n}"`.

The three `format.*` keys are added ONLY if Task 3 ran Branch B (W3 owns them); under Branch A they already exist and this test merely asserts them. Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/spectator && npm run i18n:gen-keys` and confirm `apps/web/src/lib/i18n-keys.ts` changed (`/usr/bin/git status --porcelain apps/web/src/lib/i18n-keys.ts`).

- [ ] **Step 4: Run — green; also rerun Task 4's model test (it resolves through `en`).** Then `DATABASE_URL= pnpm exec vitest run src/lib --reporter=json --outputFile=…/w3-t7-lib.json` from `apps/web` to catch any dictionary-shape or copy-truth suite that inspects `public.json` (read `numFailedTests`; a new failure there is a real finding, not noise).

- [ ] **Step 5: Commit** — "i18n(public): poster keys in en/es/fr/nl (and format keys if W3 owns them); keys regenerated; coverage test derived from POSTER_KEYS".

---

### Task 8: The download control on the fixture page (and the hub card icon)

**Files:**
- Create: `apps/web/src/components/public-site/match-centre/poster-download.tsx`
- Test: `apps/web/src/components/public-site/match-centre/__tests__/poster-download.test.tsx`
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx` (mount); extend `.../fixtures/[fixtureId]/__tests__/page.test.ts`
- Modify (only if W2 has merged, P18): `apps/web/src/components/public-site/matches-hub/match-card.tsx`

**Interfaces:**
- Produces:
  ```ts
  export const POSTER_UI_KEYS = ["poster.download", "poster.formats.label", "poster.format.feed", "poster.format.story", "poster.share"] as const;
  export interface PosterDownloadProps {
    hrefBase: string;                                   // `${basePath}/fixtures/${fixture.id}/poster.png`
    fileNames: { feed: string; story: string };         // posterFileName(...) for each format
    labels: { open: string; menu: string; feed: string; story: string; share: string };   // resolved server-side with t()
    variant: PosterVariant; displayLine: string;        // exposed as data attributes for the walkthrough (the page and the route share posterDisplayLine)
    shareTitle: string;
  }
  export function PosterDownload(props: PosterDownloadProps): JSX.Element;   // "use client"
  ```
- Consumes: `posterVariantFor`, `posterDisplayLine`, `posterFileName` (Task 4) — imported by the PAGE (server), never by the client component (they sit behind `server-only`).

- [ ] **Step 1: Failing static-markup tests**

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PosterDownload } from "@/components/public-site/match-centre/poster-download";

const props = {
  hrefBase: "/shared/o/c/d/fixtures/f1/poster.png",
  fileNames: { feed: "a-v-b-feed.png", story: "a-v-b-story.png" },
  labels: { open: "L_OPEN", menu: "L_MENU", feed: "L_FEED", story: "L_STORY", share: "L_SHARE" },
  variant: "result" as const, displayLine: "Southend Blue Blazers won by 44 runs", shareTitle: "SBB v ROC",
};

describe("PosterDownload (R7 poster-* testids, R1 one DOM, R10 no cached live poster)", () => {
  it("renders a details disclosure with the two format links as real downloads, hrefs on the route, and the variant/display data the walkthrough reads", () => {
    const h = renderToStaticMarkup(<PosterDownload {...props} />);
    expect(h).toContain('data-testid="poster-menu"');
    expect(h).toContain('data-poster-variant="result"');
    expect(h).toContain('data-poster-display="Southend Blue Blazers won by 44 runs"');
    expect(h).toContain('data-testid="poster-open"');
    expect(h).toContain('href="/shared/o/c/d/fixtures/f1/poster.png?format=feed"');
    expect(h).toContain('href="/shared/o/c/d/fixtures/f1/poster.png?format=story"');
    expect(h).toContain('download="a-v-b-feed.png"');
    expect(h).toContain('download="a-v-b-story.png"');
    expect(h).toContain('data-testid="poster-feed"');
    expect(h).toContain('data-testid="poster-story"');
  });
  it("every visible string comes from the labels prop — no English literal survives", () => {
    const h = renderToStaticMarkup(<PosterDownload {...props} />);
    for (const l of Object.values(props.labels)) expect(h).toContain(l);
    expect(h).not.toMatch(/Download poster|Feed|Story|Share image/);
  });
  it("the share button exists in the DOM at every width but is hidden until the browser proves navigator.canShare({files}) (SSR: hidden)", () => {
    const h = renderToStaticMarkup(<PosterDownload {...props} />);
    expect(h).toMatch(/<button[^>]*data-testid="poster-share"[^>]*hidden=""/);
  });
  it("one DOM: the menu body carries max-md:* / md:* branches only — no md:hidden control, no second tree", () => {
    const h = renderToStaticMarkup(<PosterDownload {...props} />);
    expect(h).not.toMatch(/\smd:hidden"/);      // anchored — /\bmd:hidden\b/ would also match inside max-md:hidden
    expect(h).not.toMatch(/\smax-md:hidden"/);
    expect((h.match(/data-testid="poster-(feed|story|share|open)"/g) ?? []).length).toBe(4);
  });
});
```

- [ ] **Step 2: Run — collection failure.**

- [ ] **Step 3: Implement**

```tsx
"use client";
// Spectator W3 — "Download poster" on the public fixture page (spec §W3 UI). A
// native <details> disclosure so it works before hydration; two real
// <a download> links on the poster route (feed / story) and, where the browser
// can share files, a button that fetches the feed PNG with cache:"no-store"
// and hands it to navigator.share — straight into Instagram/WhatsApp on a
// phone. ONE DOM for every width (R1): an inline disclosure below `md`, a
// popover at `md` and up; a bottom sheet was rejected because it needs a
// phone-only close control. A live poster is never cached: the route answers
// `no-store` and the share path asks for `no-store` (R10).
import { useEffect, useState } from "react";
import type { PosterVariant } from "@/server/og/match-poster-types";

export const POSTER_UI_KEYS = ["poster.download", "poster.formats.label", "poster.format.feed", "poster.format.story", "poster.share"] as const;

export interface PosterDownloadProps {
  hrefBase: string;
  fileNames: { feed: string; story: string };
  labels: { open: string; menu: string; feed: string; story: string; share: string };
  variant: PosterVariant;
  displayLine: string;
  shareTitle: string;
}

const LINK = "flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink hover:bg-accent-soft hover:text-accent-strong";

export function PosterDownload({ hrefBase, fileNames, labels, variant, displayLine, shareTitle }: PosterDownloadProps) {
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    try {
      const probe = new File([new Uint8Array(1)], "probe.png", { type: "image/png" });
      setCanShare(typeof navigator !== "undefined" && typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] }));
    } catch {
      setCanShare(false);
    }
  }, []);

  async function share() {
    try {
      const res = await fetch(`${hrefBase}?format=feed&t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const file = new File([await res.blob()], fileNames.feed, { type: "image/png" });
      await navigator.share({ files: [file], title: shareTitle });
    } catch {
      /* dismissed or unsupported — the links remain */
    }
  }

  return (
    <details data-testid="poster-menu" data-poster-variant={variant} data-poster-display={displayLine} className="relative">
      <summary
        data-testid="poster-open"
        className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-zinc-200/80 bg-surface px-3 py-1.5 text-sm font-medium text-accent-strong shadow-sm transition hover:bg-accent-soft [&::-webkit-details-marker]:hidden"
      >
        {labels.open}
      </summary>
      <div
        role="group"
        aria-label={labels.menu}
        className="mt-2 flex flex-col gap-1 rounded-xl border border-zinc-200/80 bg-surface p-2 shadow-lg md:absolute md:right-0 md:z-20 md:w-64"
      >
        <a href={`${hrefBase}?format=feed`} download={fileNames.feed} data-testid="poster-feed" className={LINK}>{labels.feed}</a>
        <a href={`${hrefBase}?format=story`} download={fileNames.story} data-testid="poster-story" className={LINK}>{labels.story}</a>
        <button type="button" data-testid="poster-share" hidden={!canShare} onClick={share} className={`${LINK} text-left`}>{labels.share}</button>
      </div>
    </details>
  );
}
```

`PosterVariant` must be importable by a client component: move the two type aliases `PosterFormat`/`PosterVariant` into a new `apps/web/src/server/og/match-poster-types.ts` WITHOUT `server-only` and re-export them from `match-poster.tsx` (a client component importing a `server-only` module breaks the build — memory: "Client cmp→`@/server`=BUILD FAIL").

- [ ] **Step 4: Run — green.**

- [ ] **Step 5: Mount on the page.** In `page.tsx` (after W1 Task 14, beside the share control it left; before it, beside `ShareButton` at `:149-157`): load `dict` (`getDictionary(toLocale(org.default_locale), "public")`) if the page does not already have it, and:

```tsx
const variant = posterVariantFor(fixture.status, data.matchCentre.header);
const displayLine = posterDisplayLine(variant, data.matchCentre.header, null, division.name, dict, (division.youth ?? false) && (data.matchCentre.header.sides[0].entrantId ? entrantKind !== "team" : false));
<PosterDownload
  hrefBase={`${basePath}/fixtures/${fixture.id}/poster.png`}
  fileNames={{ feed: posterFileName(home, away, "feed"), story: posterFileName(home, away, "story") }}
  labels={{ open: t(dict, "poster.download"), menu: t(dict, "poster.formats.label"), feed: t(dict, "poster.format.feed"), story: t(dict, "poster.format.story"), share: t(dict, "poster.share") }}
  variant={variant}
  displayLine={displayLine}
  shareTitle={`${home} vs ${away}`}
/>
```

`entrantKind` is not on `getPublicFixture`'s return today — read it the same way the OG image does (`data?.entrants[0]?.kind`, `opengraph-image.tsx:48`) via `getPublicDivision`, or, cheaper, have W1's document carry it; if neither is available on the page, pass `youthHide = false` here (the ROUTE applies the real rule to the poster itself; this attribute only feeds the walkthrough's result assertion) and record it. Extend `page.test.ts` (stub pattern `:43-120`): a decided cricket fixture's HTML contains `data-testid="poster-menu"`, `data-poster-variant="result"`, and both `poster.png?format=` hrefs; every string on the control comes from the dictionary (render in `fr` and assert `Télécharger l'affiche`).

- [ ] **Step 6: Run the page test — green; `pnpm exec tsc --noEmit -p tsconfig.json` from `apps/web` — clean.**

- [ ] **Step 7 (only if W2 has merged): the Matches hub card icon.** In `matches-hub/match-card.tsx`, beside the card's link: `<a data-testid={`poster-card-${m.fixtureId}`} href={`${m.href}/poster.png?format=feed`} download aria-label={t(dict, "poster.download")} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-ink-muted hover:bg-accent-soft hover:text-accent-strong"><ImageDown className="h-4 w-4" strokeWidth={1.75} /></a>` (`ImageDown` from `lucide-react`); extend W2's `match-card.test.tsx` with the testid + href assertion. If W2 has not merged, record "hub icon owed to W2's card" in the report and skip.

- [ ] **Step 8: Commit** — "public(fixture): Download poster control — details disclosure, feed/story downloads, native file share, variant/display data for the walkthrough; page wiring".

---

### Task 9: Walkthrough v3, smoke, and the regression checks

**Files:**
- Modify: `apps/web/e2e/walkthrough/spectator-public.spec.ts` (append the W3 block; W1 Task 15's seeds `live`, `done`, `upcoming`, helper names per P4)
- Modify: `scripts/smoke.ts` (one check beside W1's fixture check)

- [ ] **Step 1: Append the W3 block** (real code; helper names re-pinned against W1's file when it lands):

```ts
import { pngSize } from "../../src/lib/png-size";
// … inside the existing describe, after W1's tests; uses W1's `seed` ({ live, done, upcoming, org, comp, div, paths }) and `mustPost`.

test.describe("W3 — match poster", () => {
  test.setTimeout(180_000);

  async function anonymous(browser: Browser, width: number) {
    return browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width, height: width < 768 ? 812 : 900 }, isMobile: width < 768, hasTouch: width < 768 });
  }
  async function download(ctx: BrowserContext, href: string) {
    const res = await ctx.request.get(href);
    const body = await res.body();
    return { res, body, size: pngSize(new Uint8Array(body)) };
  }

  test("result: anonymous download of both formats at 320, exact sizes, winner in the display line, ≥44 px hit-tested control, no horizontal scroll", async ({ browser }, testInfo) => {
    const ctx = await anonymous(browser, 320);
    const page = await ctx.newPage();
    await page.goto(seed.paths.fixture(seed.done.id));
    const menu = page.getByTestId("poster-menu");
    await expect(menu).toHaveAttribute("data-poster-variant", "result");
    const display = (await menu.getAttribute("data-poster-display")) ?? "";
    expect(display, `display line names the winner: ${display}`).toContain(seed.done.winnerName);

    const open = page.getByTestId("poster-open");
    const box = (await open.boundingBox())!;
    expect(box.height, "tap target height").toBeGreaterThanOrEqual(44);
    const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-testid="poster-open"]'), [box.x + box.width / 2, box.y + box.height / 2] as const);
    expect(hit, "elementFromPoint lands on the control (a 44 px box is not a tap proven)").toBe(true);
    await open.click();
    await expect(page.getByTestId("poster-feed")).toBeVisible();
    await expect(page.getByTestId("poster-story")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${testInfo.outputPath()}/poster-menu-open-320.png`, fullPage: true });

    const feedHref = (await page.getByTestId("poster-feed").getAttribute("href"))!;
    const storyHref = (await page.getByTestId("poster-story").getAttribute("href"))!;
    expect(await page.getByTestId("poster-feed").getAttribute("download")).toMatch(/-feed\.png$/);
    for (const [href, w, h] of [[feedHref, 1080, 1350], [storyHref, 1080, 1920]] as const) {
      const { res, body, size } = await download(ctx, href);
      expect(res.status(), href).toBe(200);
      expect(res.headers()["content-type"]).toContain("image/png");
      expect(res.headers()["x-poster-variant"]).toBe("result");
      expect(res.headers()["x-poster-fonts"]).toBe("4");
      expect(res.headers()["cache-control"]).toContain("s-maxage=300");
      expect(size, href).toEqual({ width: w, height: h });
      await testInfo.attach(`poster-result-${w}x${h}.png`, { body, contentType: "image/png" });
    }
    await ctx.close();
  });

  test("control set is identical at 320 and 1280 (R1), and the open menu never scrolls the page at the seven widths", async ({ browser }) => {
    const sets: Record<number, string[]> = {};
    for (const width of [320, 1280]) {
      const ctx = await anonymous(browser, width);
      const page = await ctx.newPage();
      await page.goto(seed.paths.fixture(seed.done.id));
      await page.getByTestId("poster-open").click();
      sets[width] = (await controlSet(page)).controls.filter((c) => c.includes("poster-"));
      await ctx.close();
    }
    expect(sets[1280]).toEqual(sets[320]);
    for (const width of [320, 360, 375, 390, 430, 768, 834]) {
      const ctx = await anonymous(browser, width);
      const page = await ctx.newPage();
      await page.goto(seed.paths.fixture(seed.done.id));
      await page.getByTestId("poster-open").click();
      await expect(page.getByTestId("poster-story")).toBeVisible();
      await expectNoHorizontalScroll(page);
      await ctx.close();
    }
  });

  test("live: no-store, and two downloads around one API-posted ball are DIFFERENT posters (R10)", async ({ browser, request }) => {
    const ctx = await anonymous(browser, 375);
    const page = await ctx.newPage();
    await page.goto(seed.paths.fixture(seed.live.id));
    await expect(page.getByTestId("poster-menu")).toHaveAttribute("data-poster-variant", "live");
    await page.getByTestId("poster-open").click();
    const href = (await page.getByTestId("poster-feed").getAttribute("href"))!;
    const first = await download(ctx, href);
    expect(first.res.headers()["cache-control"]).toBe("no-store");
    expect(first.res.headers()["x-poster-variant"]).toBe("live");
    expect(first.size).toEqual({ width: 1080, height: 1350 });
    await mustPost(request, seed.live.id, "cricket.ball", seed.live.nextBall({ bat: 4, boundary: 4 }));   // W1's helper derives over/ballInOver/striker from the ledger
    await expect.poll(async () => Buffer.compare(first.body, (await download(ctx, href)).body), { timeout: 45_000, intervals: [2_000] }).not.toBe(0);
    await ctx.close();
  });

  test("upcoming: variant, 60 s policy, kick-off line present; a PRIVATE competition's poster 404s (regression)", async ({ browser, request }) => {
    const ctx = await anonymous(browser, 375);
    const page = await ctx.newPage();
    await page.goto(seed.paths.fixture(seed.upcoming.id));
    await expect(page.getByTestId("poster-menu")).toHaveAttribute("data-poster-variant", "upcoming");
    await page.getByTestId("poster-open").click();
    const href = (await page.getByTestId("poster-story").getAttribute("href"))!;
    const { res, size } = await download(ctx, href);
    expect(res.headers()["cache-control"]).toContain("s-maxage=60");
    expect(size).toEqual({ width: 1080, height: 1920 });
    // private competition → 404 like its page (`visibility` defaults to "private", schemas.ts:94; stated explicitly anyway)
    const priv = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", { name: `W3 private ${TAG}`, visibility: "private", ends_on: "2030-12-31" });
    const pdiv = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${priv.data!.id}/divisions`, "POST", { name: "Priv", sport_key: "cricket", variant_key: "t20" });
    for (const display_name of ["Priv A", "Priv B"]) {
      await apiJson(request, `/api/v1/divisions/${pdiv.data!.id}/entrants`, "POST", { kind: "team", display_name });
    }
    // helpers.ts:1383-1390 — creates a league stage and generates fixtures; it creates NO entrants, hence the two POSTs above
    const { fixtureIds } = await createStageAndGenerate(request, pdiv.data!.id);
    const r404 = await ctx.request.get(`/shared/${seed.org.slug}/${priv.data!.slug}/${pdiv.data!.slug}/fixtures/${fixtureIds[0]!}/poster.png`);
    expect(r404.status()).toBe(404);
    await ctx.close();
  });
});
```

Imports the block needs at the top of the spec if W1's file does not already have them: `import type { Browser, BrowserContext } from "@playwright/test";`, `import { apiJson, createStageAndGenerate, expectNoHorizontalScroll, TAG } from "../helpers";`, and W1's `controlSet`/`mustPost`/`seed` from wherever W1 Task 15 exported them (P4).

- [ ] **Step 2: Run against a fresh env**: from the worktree `seazn-env up --label spx --server`, `eval "$(seazn-env env --label spx)"`, then `cd apps/web && PLAYWRIGHT_BASE=$SMOKE_BASE npx playwright test e2e/walkthrough/spectator-public.spec.ts --project=walkthrough --workers=1 --reporter=json > /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/6262000e-0d12-4731-97e2-7a60369846eb/scratchpad/w3-wt.json` (the WHOLE file, never `-g`). Judge on the JSON; a timeout reports itself as a data defect — check the wall clock before chasing a count. Attach the six PNGs (three variants × two formats: add the live and upcoming FEED/STORY attachments by mirroring the result test's loop) — these are the R11 artefacts.

- [ ] **Step 3: Smoke** — beside W1's fixture check in `scripts/smoke.ts` (P17), using its fixture id and slugs:

```ts
  const posterRes = await fetch(`${BASE}/shared/${proOrgSlug}/${compSlug}/${divSlug}/fixtures/${fixtureId}/poster.png?format=story`);
  const posterBytes = new Uint8Array(await posterRes.arrayBuffer());
  const posterView = new DataView(posterBytes.buffer, posterBytes.byteOffset, posterBytes.byteLength);
  check(
    "spectator W3: match poster story PNG — 200, image/png, 1080×1920, four fonts loaded",
    posterRes.status === 200 &&
      (posterRes.headers.get("content-type") ?? "").includes("image/png") &&
      posterBytes.length > 20_000 &&
      posterView.getUint32(16) === 1080 &&
      posterView.getUint32(20) === 1920 &&
      posterRes.headers.get("x-poster-fonts") === "4",
  );
```

Run: `SMOKE_BASE=$SMOKE_BASE node --experimental-strip-types scripts/smoke.ts` (pin the exact invocation from `package.json`'s `smoke` script) → the new check prints PASS.

- [ ] **Step 4: OG-card regression (byte-identical, spec + prompt)** — from the worktree: `/usr/bin/git diff --stat origin/main -- apps/web/src/server/og/card.tsx apps/web/src/server/og/model.ts` and the same for each `opengraph-image.tsx` under `apps/web/src/app/(public)/shared` (one path per command; the guard refuses loops) → every command prints nothing. Also `DATABASE_URL= pnpm exec vitest run src/server/og/__tests__/og-model.test.ts src/server/og/__tests__/post-card.test.ts --reporter=json --outputFile=…` → `numTotalTests` equals the count on `origin/main` (record both numbers).

- [ ] **Step 5: Take the env down.** Commit — "e2e(spectator): walkthrough v3 — anonymous poster downloads (feed 1080×1350, story 1080×1920), winner in the result line, live regenerates per download, control-set parity 320/1280, seven-width open menu, private 404; smoke check".

---

### Task 10: Gates, review loop, R11 visual sign-off

- [ ] **Step 1: Orchestrator runs the full gate** from the worktree on a quiescent tree: `seazn-env gate --label spx` (lint + typecheck); `cd apps/web && pnpm exec vitest run --reporter=json --outputFile=…/w3-web.json`; `cd packages/engine && pnpm exec vitest run --reporter=json --outputFile=…/w3-eng.json`; paste `numTotalTests`/`numFailedTests`/`numFailedTestSuites` for both and confirm `.testResults[].name` paths are under the worktree; `npm run openapi:gen && /usr/bin/git status --porcelain openapi` prints nothing (the route is a public page route, not an `/api/v1` route — nothing in the spec should move; confirm rather than assume).
- [ ] **Step 2: Reviewer dispatch** on the whole branch (Opus; brief = this plan + `_RULES.md` + spec §W3; output = gap list). Fix inline; re-review until clean. Run the final whole-branch review even if every task review was clean.
- [ ] **Step 3: R11 visual sign-off.** On the `spx` prod build with the walkthrough's seeded data: the six posters (upcoming/live/result × feed/story) opened at 100 % and READ — the 43-character entrant name ("Southend Blue Blazers Cricket Club 1st XI") must fit its pill on two lines without clipping; badge tiles vs monogram tiles side by side; scores baseline-aligned with their overs; the LIVE pill's dot centred; pills evenly spaced; the sponsor strip and footer aligned; contrast of muted text on the court colour. The control at 320/768/1280 closed and open (popover at ≥768 must not clip at the viewport's right edge; inline disclosure at 320 must not push the court card off-screen unexpectedly). Append "W3 sign-off — per-screen verdicts" to the spec, one row per image/screen naming what was SEEN; a cosmetic defect is a defect — one fix dispatch with the review findings, never parked.
- [ ] **Step 4: `_INDEX.md`** (in the wave's PR, by the orchestrator): W3 row → "PR #… open"; false premises found (start with P6: `badge_url` IS written); the Task 1 renderer fact; Task 3's ownership branch; mutants a–e with the test that killed each; the measured walkthrough cost.
- [ ] **Step 5: Open the PR** only when the owner says so; e2e runs on `workflow_dispatch` with the PR number once a PR exists (e2e does not run on PRs; smoke is PR-only).

---

## Execution order

Sequential: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10.** Parallel lanes with provably disjoint files: Task 2 beside Task 1 (`poster-image.ts` vs `poster-fonts.ts`/`png-size.ts`); Task 7's dictionary edits beside Tasks 5–6 once Task 4 has fixed `POSTER_KEYS` (Task 8's `POSTER_UI_KEYS` is a fixed list in this plan, so the keys can be added early). Hard dependencies on other waves: **W1 Task 9** (`matchCentre` on `getPublicFixture`) before Task 6; **W1 Task 14/15** (page + walkthrough file) before Tasks 8–9; **W2 Task 4** (`describeFormat`, `PublicDivision.config`) before Task 3, or W3 owns them (Task 3 Branch B, Q3).

## Open questions for the product owner (recommendations stated as owner value)

- **Q1 — Fonts: which OFL pair, and where they live.** Recommendation: Barlow Condensed 700/600 + Geist 400/700 static TTFs (the app's own faces, so a poster reads as the same product as the page) under `apps/web/public/fonts` per the spec, with Inter statics as the recorded substitute if Geist ships no static TTF. Cost: ~600 KB in the repo, one licence file each; risk: satori cannot use variable fonts or woff2, so this is the only working shape. Counter-argument: satori's bundled default costs nothing — but it is one weight, so every "bold" on the poster would be fake.
- **Q2 — Title sponsor on posters of orgs WITHOUT `sponsors.tiers` (free/community).** Spec as written: the strip appears only when a title tier exists, which the free plan cannot have. Recommendation: keep the spec (title tier only) for this wave — a poster is a premium placement, tiers are the Pro line today, and R6 forbids new rows or looser reads; revisit in entitlements v18 whether "first partner sponsor on the poster" becomes a community perk (it would help the growth loop and the sponsor). Counter-argument: the spec's value statement "the sponsor gets a logo on every shared poster" is not true for free orgs under this rule.
- **Q3 — Ownership of `describeFormat` and `PublicDivision.config` if W2 has not merged when W3 starts.** Recommendation: W3 builds both with W2's exact contract (Task 3 Branch B) and W2 drops its copy — one shared literal, one owner, no merge ugliness (the "one side reordered, the other inserted" trap). Counter-argument: it widens W3's blast radius by one column in `getPublicCompetition`'s SELECT (cache key bump).
- **Q4 (minor) — Testid prefix.** Spec R7 and `W3-poster.md` say `poster-*`; the dispatch brief said `mc-poster-*`. This plan follows the spec; reversing it is a global rename of the `poster-` literals in Tasks 8–9.
- **Q5 (minor) — Poster locale.** The org's `default_locale` (the poster is shared onward to the org's audience and stays CDN-cacheable), as `poster.pdf` does — not the downloader's locale.

## Self-review (done while writing)

- **Spec coverage**: route + caching + private 404 → Task 6; model beside `post-card.tsx` reusing `ogTheme` and the youth rule → Task 4; anatomy items 1–6 → Task 5; result variant (scores, result line, ≤2 performers, masked dropped) → Tasks 4–5; live variant (LIVE pill, score + overs, CRR/RRR, batters, updated HH:MM) → Tasks 4–5; story 1080×1920 same components → Tasks 1, 5, 6; fonts under `public/fonts` with licence → Task 1; badges fetched with a timeout, monogram fallback → Task 2 + 6; UI "Download poster" feed/story with `<a download>` + `navigator.share({ files })`, hub card icon → Task 8; tests: unit (model per variant × format, masking drops the line, badge fallback ladder 404/timeout/absent, sponsor strip, branded footer, `describeFormat` per sport) → Tasks 2–5; e2e walkthrough v3 (both formats downloaded anonymously, PNG decoded to 1080×1350 and 1080×1920, result text through the model) → Task 9; smoke → Task 9; regression (private 404, masked minor never reaches the model, OG card byte-identical) → Tasks 4, 9; visual (three × two rendered and read) → Tasks 9–10; four locales → Task 7; R10 live regeneration → Tasks 6, 8, 9. Gap found and closed while reviewing: the abandoned/no-result case (spec §Error and empty states) → `posterVariantFor`'s `other` branch (Task 4).
- **Placeholders**: every test step carries code; the only conditional prose is Task 3's Branch A/B and Task 8 Step 7, both with the exact check that decides them.
- **Type consistency**: `MatchPosterInput`/`MatchPosterModel`/`PosterTile` (Task 4) are what Task 5's card and Task 6's route consume; `posterVariantFor`, `posterDisplayLine`, `posterFileName`, `posterCachePolicy` are named identically in Tasks 4, 6 and 8; `POSTER_KEYS` (Task 4) and `POSTER_UI_KEYS` (Task 8) are what Task 7's coverage test imports; `PosterVariant` moves to `match-poster-types.ts` in Task 8 and is re-exported, so Task 4's import path stays valid; `pngSize` (Task 1) is the single decoder used by Tasks 1, 2, 6, 9.
