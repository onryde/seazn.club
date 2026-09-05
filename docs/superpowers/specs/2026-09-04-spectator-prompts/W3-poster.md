# W3 — the match poster (feed + story; upcoming, live, result)

Read `_RULES.md` → `_INDEX.md` → spec §W3. Plan:
`../../plans/2026-09-04-spectator-w3.md` (written after W2 merges). Worktree;
one PR. Depends on W1 (result/live variants read the fold) and W2 (poster icon
on match cards).

## Why the wave exists

The owner showed a match poster (crests, stage label, "8-over match",
date/time) and asked for one per match, dynamic, downloadable at Instagram
size. Every shared poster carries the competition's colours, the sponsor's
logo and — for free orgs — "Powered by seazn". It is the growth loop drawn as
a picture. The pipeline exists (`news/[postSlug]/story.png` renders 1080×1350
with satori); the crests and colours exist in the DB and reach no card.

## Scope

1. **Route** `…/fixtures/[fixtureId]/poster.png?format=feed|story`, `next/og`
   `ImageResponse`; caching by status (upcoming 60 s, live no-store, final
   300 s); private competition → 404 like its page.
2. **Model** `apps/web/src/server/og/match-poster.tsx` — `matchPosterModel(...)`
   pure; reuses `ogTheme`/`resolvePublicTheme` and `fixtureCardModel`'s youth
   rule; variant by fixture status; crest = real badge (`entrants.badge_url`,
   `team_display_v.logo_path`) fetched with a timeout, else monogram in
   `colors.primary` or a deterministic palette colour; `describeFormat` per
   sport module (keys, not English); title-sponsor strip when present; footer
   per `org.branded`.
3. **Anatomy** per spec (logo · competition eyebrow · stage/round display line ·
   crests with "V" · name pills · format line · date/time/venue pill · footer).
   Result: scores under crests, result line as display line, two top-performer
   lines (a masked performer is dropped). Live: LIVE pill, score + overs,
   CRR/target/RRR, batters at the crease, "updated HH:MM". Story 1080×1920:
   same components, stretched rhythm.
4. **Fonts** — an OFL display + text family, bold and regular, pinned under
   `apps/web/public/fonts` with its licence; image routes only.
5. **UI** — fixture page share bar gains "Download poster" (feed / story): a
   real `<a download>` plus `navigator.share({ files })` where available;
   Matches hub cards get the poster icon. Testids `poster-*`.
6. **Walkthrough v3** — download both formats from the fixture page in the
   anonymous context; decode the PNG; assert 1080×1350 and 1080×1920; assert
   the result variant's text through the model.

## Do NOT touch

The landscape OG card's design; the competition QR poster / `poster.pdf`; the
organiser console; entitlement matrix/copy; the engine.

## Acceptance — all four test types

- **Unit**: model per variant × format; masking drops the line; badge fallback
  ladder (404, timeout, absent); sponsor strip presence; branded footer switch;
  `describeFormat` per sport.
- **E2E**: walkthrough v3 in `--project=walkthrough`.
- **Smoke**: `poster.png` 200, `image/png`, non-trivial size, for one fixture.
- **Regression**: private competition's poster 404s; a masked minor never
  reaches the model; the OG card is byte-identical to before.
- **Visual**: three variants × two formats rendered and attached to the PR,
  checked against the W0 pick.

## Gates

As W1.

## Plan (DRAFT, 2026-09-05)

**Plan:** `docs/superpowers/plans/2026-09-05-spectator-w3-poster.md` (DRAFT — the
path the header of this prompt names, `2026-09-04-spectator-w3.md`, is superseded
by this one; not yet approved for execution). Drafted by a Fable agent under
owner ruling 14 (corrected): planning only, docs only.

**Tasks and order:** 10 tasks, TDD, all four test types — 1 fonts + renderer
spike → 2 image fetcher → 3 `describeFormat` (consume W2's or own it) → 4 pure
model → 5 satori card → 6 route → 7 dictionaries → 8 download control + page →
9 walkthrough v3 + smoke + OG regression → 10 gates, review, R11 sign-off.
Lanes: 2 beside 1; 7 beside 5–6. Hard dependencies: W1 Task 9 (`matchCentre` on
`getPublicFixture`) before 6; W1 Tasks 14–15 (page, walkthrough file) before 8–9;
W2 Task 4 (`describeFormat`, `PublicDivision.config`) before 3, else W3 owns them.

**Open owner questions (recommendation each):**
- Q1 Fonts — which OFL pair and where. Recommend Barlow Condensed 700/600 +
  Geist 400/700 STATIC TTFs (the app's own faces; satori takes no woff2 and no
  variable fonts) under `apps/web/public/fonts` per the spec; Inter statics as
  the recorded substitute if Geist ships no static TTF.
- Q2 Title sponsor on posters of orgs without `sponsors.tiers` — the spec's
  rule means a free org's sponsor never reaches the poster. Recommend keeping
  the spec this wave (R6: no new or looser gate); revisit in entitlements v18.
- Q3 Ownership of `describeFormat` + `PublicDivision.config` if W2 has not
  merged when W3 starts. Recommend W3 builds both with W2's exact contract and
  W2 drops its copy — one owner for the shared literal.
- Q4 (minor) Testid prefix: the spec and this prompt say `poster-*`; the
  dispatch brief said `mc-poster-*`. The plan follows the spec.
- Q5 (minor) Poster locale: the org's `default_locale` (as `poster.pdf`), not
  the downloader's.

**False premises found while reading the tree:**
- The spec's watch-list item "`entrants.badge_url` may be written nowhere" is
  FALSE: it is written on create (`usecases/entrants.ts:381`), cleared (`:545`)
  and set by the upload route (`:562`, `api/v1/entrants/[id]/badge/route.ts`),
  and edited from `components/v2/entrants-panel.tsx`. Both crest sources are
  live and `resolveEntrantBadge` (`lib/entrant-badge.ts:8-16`) already merges
  them. The upload accepts webp and svg — satori/resvg decode neither webp nor
  arbitrary sizes well, so every badge is normalised through `sharp` (already a
  dependency) before it reaches the card.
- "Rendered exactly as `story.png` is" hides two differences: every existing
  `ImageResponse` call site passes NO `fonts:` option and uses
  `fontFamily: "sans-serif"` (so today's OG "bold" is satori's single default
  face, not a bold), and `story.png` is statically cacheable (`revalidate`)
  because it never reads the request — the poster reads `?format`, is therefore
  dynamic, and must set `Cache-Control` per variant itself.
- No image taller than 1350 px has ever been rendered here, and no unit test
  decodes an `ImageResponse` PNG — the plan's Task 1 is the spike that proves
  1080×1920 with custom fonts, both under vitest and on the `spx` prod build
  (standalone `public/` layout, `Dockerfile:81-88`).
- `describeFormat` exists nowhere on the branch; the W2 DRAFT owns it. This
  prompt's "`describeFormat` per sport module" is a dependency, not a reuse.
- Existing `poster.*` keys are in the `ui` namespace (`en/ui.json:4663-4665`,
  read by `poster.pdf` through `msgFor`); this wave's keys go into
  `public.json` — no collision, but grep both before adding.
- Team colours: `team_display_v.colors` is jsonb typed `unknown` everywhere;
  the spec's `colors.primary` key is unverified — the model reads `primary`
  defensively and falls back to the palette; pin the real shape in Task 4.
- The `walkthrough` Playwright project is SIGNED IN (`storageState: AUTH_STATE`);
  "anonymous" needs an explicit empty-state context.

**Re-pin after W1/W2 merge:** every `file:line` in the plan's premises table
(P1–P20) was opened on 2026-09-05 on `feat/spectator-surface`; W1 Tasks 6, 8, 9,
14–18 are on lane branches and W2 is an unreviewed draft, so P1–P5, P17–P18
move on merge. Re-pin before dispatching Task 3 or later; a false premise is a
finding for `_INDEX.md`, not a blocker.
