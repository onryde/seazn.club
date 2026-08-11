# Conflict details show names, not UUIDs — structured conflict details

**Date:** 2026-08-12 · **Status:** approved design, not implemented ·
**Symptom:** the board conflict tooltip renders
`entrant 6be47174-7f41-4030-… below rest` — a raw entrant UUID.

## Today

- The prose is built inside the engine:
  `packages/engine/src/scheduling/calendar.ts:1350`
  (`` `entrant ${e} below rest` ``) and `:1380` (person variant), plus the
  same family at `:686`, `:1341`, `:1361` (person/entrant overlaps embedding
  person ids and fixture ids).
- It flows unchanged through `apps/web/src/server/usecases/schedule.ts:755`
  and the public validate route, landing as `title=` on the conflict badge
  (`apps/web/src/components/v2/board/fixture-block.tsx:150-162`) and on three
  more surfaces: `conflicts-panel.tsx:166`, `ai-diff-panel.tsx:165-166`,
  `ai-review-panel.tsx:162`.
- Hardcoded English — already violates the four-locale rule. Only the label
  (`board.conflict.${code}`) is localized.
- `FixtureBlock` already receives `entrantNames`
  (`page.tsx:173` builds it; card titles use it via `cardTitle`,
  `types.ts:107-118`) — name data is on hand, the string just never used it.
- The `types.ts:77-100` comment "no codes, no UUIDs" is currently false.

## Decision — structured details, localized at render

### Engine
Conflicts stop building prose. Each conflict emits a structured
`details` entry: `{ kind, entrantIds?, personIds?, fixtureIds?,
otherFixtureId? }`, with kinds covering the whole family:
`below_rest` (entrant and person variants), `entrant_overlap`,
`person_overlap`, `person_double_booking`. The engine stays id-only — it has
no display names, and gains none.

### API
The public validate route keeps the legacy `detail` string for back-compat,
now **derived at the API layer** from the structured entry (English), marked
deprecated. The structured `details` field is additive. Regenerate
`openapi/v1.public.json` locally (the drift gate is CI-only) and commit with
`git status --porcelain` clean.

### Client
One shared formatter, used by all four surfaces. It:
- localizes via `board.conflict.detail.*` keys — added to **all four** locale
  dictionaries (flat dotted keys);
- resolves entrant ids through the existing `entrantNames` map and fixture
  ids through a fixture-title map (`cardTitle` already derives titles);
- resolves person ids when a person-name map is in scope on that surface;
  otherwise falls back to a shortened id (first 8 chars). A full UUID is
  never rendered.

### Comment
`types.ts:77-100` "no codes, no UUIDs" becomes true again; update its
wording to reference the structured path.

## Tests (each fails without its change)

- Engine unit: every family template emits a structured `details` entry with
  the right ids — fails on the prose-only code.
- Formatter unit: localized output with names; short-id fallback when a map
  entry is missing; joined multi-conflict rendering (`"; "` behavior kept).
- UI: the badge `title` contains the entrant display name and no UUID —
  anchored assertions (`="…"`), never bare presence, per the RSC
  `"$undefined"` trap.
- i18n: key parity across the four dictionaries (i18n:gen-keys gate).
- Legacy: API-layer derived `detail` string equals today's English for a
  fixture corpus (back-compat proof).
- Before merge: grep e2e for the literal tooltip text (UI-text-breaks-e2e
  rule), `grep -a`.

## Out of scope

- Conflict UI redesign — tooltip and panels keep their layout.
- Persisting structured details — conflicts remain computed on validate
  (verify nothing stores `detail` prose; if something does, the additive
  field leaves its read path untouched).
- Localizing the deprecated `detail` string — it stays English until removed.
