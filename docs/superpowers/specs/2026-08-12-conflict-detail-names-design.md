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

#### AMENDED 2026-08-13 (C3 session) — the family is 25 kinds, not 4

Re-pinning the citations found the design had **understated the family the
same way C1's "same-division pair" was understated**. Ground truth:
`calendar.ts` builds **23** detail templates and `build.ts` two more, and the
four kinds named above cover five of them. Owner ruled 2026-08-13: convert
**all** of them, because the badge `title` joins every detail with `"; "` —
a partial conversion renders a localized fragment next to an English one in
one string, which is worse than the uniform English it replaces.

Nine templates leak a raw id, not the four this design implies. The four it
never named are `no_slot_person_bound`, `court_double_booking`,
`order_before_feeder` and `order_inside_feeder_rest`.

The shape above is also insufficient: several templates interpolate scalars
(a court label, a day key, a weekday, minute counts, round numbers) that
`{entrantIds, personIds, fixtureIds, otherFixtureId}` cannot carry. The
shipped `ConflictDetail` keeps that id vocabulary and adds those scalars as
optional fields. `fixtureIds` is dropped — no template ever needed a list;
every counterparty reference is the single `otherFixtureId`.

| # | site | kind | fields beyond `kind` |
|---|---|---|---|
| 1 | `calendar.ts:735` | `person_double_booking` | `personIds`, `otherFixtureId` |
| 2 | `calendar.ts:748` | `locked_slot_clash` | `court` |
| 3 | `calendar.ts:835` | `no_slot_start_window` | — |
| 4 | `calendar.ts:837` | `no_slot_person_bound` | `personIds`, `otherFixtureId` |
| 5 | `calendar.ts:838` | `no_slot_horizon` | — |
| 6 | `calendar.ts:1088` | `instruction_feeder_gap` | `minutes`, `requiredMinutes` |
| 7 | `calendar.ts:1117` | `instruction_day_cap` | `count`, `day`, `requiredCount` |
| 8 | `calendar.ts:1136` | `instruction_weekday` | `weekday`, `day`, `requiredWeekday` |
| 9 | `calendar.ts:1143` | `instruction_date` | `day`, `requiredDate` |
| 10 | `calendar.ts:1159` | `instruction_time` | `time`, `ruleType`, `requiredTime` |
| 11 | `calendar.ts:1349` | `outside_competition_window` | — |
| 12 | `calendar.ts:1358` | `outside_start_window` | — |
| 13 | `calendar.ts:1388` | `court_double_booking` | `court`, `otherFixtureId?` |
| 14 | `calendar.ts:1395` | `inside_blackout` | — |
| 15 | `calendar.ts:1401` | `outside_session_windows` | — |
| 16 | `calendar.ts:1412` | `entrant_overlap` | `entrantIds`, `otherFixtureId` |
| 17 | `calendar.ts:1421` | `entrant_below_rest` | `entrantIds` |
| 18 | `calendar.ts:1432` | `person_overlap` | `personIds`, `otherFixtureId` |
| 19 | `calendar.ts:1451` | `person_below_rest` | `personIds` (multi) |
| 20 | `calendar.ts:1497` | `order_before_feeder` | `otherFixtureId` |
| 21 | `calendar.ts:1498` | `order_inside_feeder_rest` | `otherFixtureId`, `requiredMinutes` |
| 22 | `calendar.ts:1618` | `round_order_day` | `roundNo`, `otherRoundNo`, `day`, `otherDay` |
| 23 | `calendar.ts:1625` | `round_order_same_day` | `roundNo`, `otherRoundNo`, `day` |
| 24 | `build.ts:809` | `no_slot_lattice` | — |
| 25 | `build.ts:810` | `no_slot_budget` | — |

`court_double_booking` alone has an optional `otherFixtureId`: `:1384`
falls back to the literal `"another fixture"` when `courtBlocked` and the
`hits` filter disagree, and that fallback is a reportability guard the
conversion must keep rather than a counterparty it can assume exists.

### `conflictKey` — the constraint this design did not account for

`conflictKey` (`calendar.ts:218`) is `fixtureId|reason|detail`, and the
prose is in there **deliberately**: three separate comments
(`:829`, `:1364-1376`, `:1479-1495`) record that the counterparty id inside
the string is what makes a swap, an added collision, and a rest breach
hiding behind an ordering violation distinguishable. It feeds
`deltaConflicts` (`:262`, `:270`), `repair-minimality.ts:173/178/190` and the
joint apply gate (`competition-schedule-apply.ts:663/675/699/701`) — so
changing what it hashes changes which edits the organiser's apply refuses.

Owner ruled 2026-08-13: key on a **canonical serialization** of the
structured detail, and prove the partition is unchanged rather than assume
it. Two tests carry that proof, because neither alone is sufficient:

- **per-kind field participation** (engine): for every kind, mutating each
  populated field changes the key. Catches a field dropped from `canon`.
- **legacy prose parity** (API layer): over a fixture corpus the derived
  English equals today's byte-for-byte, and grouping that corpus by old
  prose key and by new canonical key yields the **same partition**.

### Consumers this design did not name

The four surfaces listed under `Client` are not the whole set, and two of
them do not render `detail` at all. `conflicts-panel.tsx:125` and
`schedule-gate-dialog.tsx` resolve `board.conflictHelp.<code>` first and
only fall back to `detail` when that key is missing — and every live code
has one, so the prose is already dead on both. The surfaces that DO render
it are `fixture-block.tsx:153` (the reported symptom), `ai-diff-panel.tsx`,
`ai-review-panel.tsx` (via `ai-review.ts:64`), `ai-competition-console.tsx:790`
and `ai-trace-compose.ts:58`.

And one consumer parses it: **`use-board-actions.ts:303` regex-scrapes a
UUID back out of the prose** to title a card. It is also latently wrong —
the regex takes the FIRST id, which for `entrant_overlap` / `person_overlap`
is the entrant or person, so `board.find(x => x.id === …)` misses and the
enrichment silently degrades to "another match". Structured details fix
that as a side effect; it reads `details.otherFixtureId` instead.

### The prose reaches the MODEL, not just the screen

The design treats `detail` as a display string. It is also **model input**.
`schedule-ai.ts:2189` and `competition-schedule-ai.ts:2130` put the raw
engine `Conflict[]` on the repair-round conversation as `verifier_conflicts`
— no mapper, no field stripping, `JSON.stringify` straight into
`callModel` / `callJointModel`. Both import the engine `Conflict` type
directly. So "the engine stops building prose" would, unnoticed, change
what the AI repair round reads.

**Ruling (C3 session, 2026-08-13): the model's input stays byte-identical.**
`verifier_conflicts` carries the derived legacy English, produced by the
same deprecated deriver the API layer uses for the wire's `detail`. Not
because prose is better for the model — structured `kind` tokens plausibly
are, and #399 already moved the repair round toward citing `rule` — but
because nothing in this task measures repair quality, and an unmeasured
change to what a paid model sees is not a rendering fix. It also keeps the
request's token weight unchanged, which the AI-credit accounting depends on.

Sending `details` instead of (or beside) the prose is a real follow-up, and
it should be taken with a repair-quality measurement attached. Recorded, not
done.

Consequence for the deriver's home: it cannot be a client-side formatter.
It must live server-side where both the API mappers and the two AI usecases
can import it.

### Officials

Officials conflicts (`packages/engine/src/officials/assign.ts:157`,
`:274`, `:293`, `:326`) are a **different producer and a different type**
(`OfficialConflict` / `AiOfficialsConflict`), and `:157` embeds a fixture
id. Out of scope here, and left alone — recorded so the next reader does
not mistake it for a miss.

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
