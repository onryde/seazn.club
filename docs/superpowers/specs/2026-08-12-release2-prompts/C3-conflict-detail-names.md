# C3 — structured conflict details (names, not UUIDs)

Spec of record: `../2026-08-12-conflict-detail-names-design.md`.
Not concurrent with C1 (both edit `schedule.ts`).

## Goal

Conflict tooltips/panels show entrant display names, localized; raw UUIDs
never render. Engine emits structured `details`; prose becomes an API-layer
derived, deprecated field.

## File set

- `packages/engine/src/scheduling/calendar.ts` — replace prose templates
  (~:686, :1341, :1350, :1361, :1380) with structured
  `{kind, entrantIds?, personIds?, fixtureIds?, otherFixtureId?}`.
  Engine stays id-only.
- `apps/web/src/server/usecases/schedule.ts` (~:755) + the validate route —
  pass structured through; derive legacy `detail` string (English) at the API
  layer; mark deprecated.
- One shared client formatter used by all four surfaces:
  `fixture-block.tsx` (~:150-162), `conflicts-panel.tsx` (~:166),
  `ai-diff-panel.tsx` (~:165-166), `ai-review-panel.tsx` (~:162).
  Names via existing `entrantNames`/`cardTitle` maps; short-id (8 chars)
  fallback only.
- `board.conflict.detail.*` keys in **all four** locale dictionaries.
- `apps/web/src/components/v2/board/types.ts` (~:77-100) — make the
  "no codes, no UUIDs" comment true again.
- Regenerate `openapi/v1.public.json` (additive field), porcelain clean.

## Do NOT touch

Conflict computation logic (what counts as a conflict), badge/panel layout,
persistence (conflicts stay computed-on-validate — verify nothing stores the
prose; report if something does).

## Acceptance

- Engine unit: every family template emits structured details (fails on
  prose-only code).
- Formatter unit: localized + name-resolved output; short-id fallback;
  `"; "` join preserved.
- Legacy parity: derived `detail` equals today's English on a fixture corpus.
- UI: badge `title` contains a display name and no UUID — anchored `="…"`
  assertions (RSC `"$undefined"` trap).
- i18n gen-keys gate clean; e2e text-grep for the old literals done.
- Screenshot verification 1280/320/768 (tooltip + panels).

## Verify

apps/web + engine suites (JSON reporter numbers), i18n + openapi drift gens
run locally.
