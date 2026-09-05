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
