# F5 — closing the format-progression programme

*Design of record, 2026-08-24. Supersedes the F5 scope in
`2026-08-18-format-progression-f3-f5-design.md` §5 and §8, and the "Left for
F5" block in `2026-08-17-format-progression-prompts/_INDEX.md`. Both remain
accurate about **why** each item exists; neither is accurate about the code as
shipped. Read §1 before either of them.*

Owner rulings, 2026-08-24: F5 ships **both** accumulated scopes in one PR — the
F4 leftovers *and* the §5 test debt — plus the day-one full-draw poster and the
two adjacent paywall defects. F1–F4 are merged (`#606`, `#616`, `#617`, `#619`).
F6 (`#625`, `standings.carry_over`) is unaffected and still follows.

---

## 1. Premises that are already false

F5 inherited its task list from F4's final review. Three entries no longer
describe `main`. This is the programme's own recurring failure — §6 of the
F3–F5 design named it — so the corrections are recorded here rather than
discovered again by whoever implements.

| Inherited claim | What `main` actually does |
|---|---|
| `packages/engine/src/exports/build.ts:40` — `timeOf()` hardcodes `"TBD"` for every day-one fixture | **Half-fixed.** F4 built the caller-supplied seam: `fixtureRows(fixtures, timeTbc)` takes the word as a parameter, and `TIME_TBC = "TBD"` (`:60`) is only the fallback for callers passing no `opts.i18n`. The engine has no locale of its own and correctly does not acquire one. What is still English is listed in §2. |
| `calendar.ics/route.ts:37,80` — `?? "TBD"` and `?? "Entrant"` hardcoded | **Fixed.** The route resolves `toLocale(data.org.default_locale)` and routes both through `msgFor` — `calendar.unknownEntrant` for a missing entrant, `resolveSlotLabel(label, lookup, "schedule.tbd")` for an unresolved slot. It also already anchors untimed fixtures as all-day `STATUS:TENTATIVE` events under a stable UID. |
| `registrations.ts:3001-3024` — second VCALENDAR builder applies no escaping, injection risk on comma/semicolon | **False.** Both `SUMMARY` and `DESCRIPTION` are wrapped in `icsText()`, which does RFC 5545 §3.3.11 escaping. The builder has real defects, but they are different ones — see §4. There is no injection risk here and F5 should not claim to have fixed one. |

Two line references also drifted: the tautological assertion in
`format-gallery.test.ts` is at `:90`, not `:97`; and of the five stray
`?? "TBD"` sites, `schedule.ts:2598` and `officials.ts:600` no longer exist.

**The pattern, stated once more:** every one of these was written by a careful
reviewer against code that was correct at the time. Line numbers and premises
in this repo decay within days. Verify each item against `main` before
implementing it, including the items in this document.

---

## 2. Wave 1 — finish the engine export i18n seam

F4 built the seam and wired three of its fields. The rest of the document
builder still emits English.

- `BuildOpts["i18n"]` (`packages/engine/src/exports/types.ts:276`) carries
  `timeTbc`, `timetableColumns`, `rotaColumns`, `participantsColumns`.
- Still English on a French poster:
  - `home ?? "TBD"` / `away ?? "TBD"` at `build.ts:288,289,326,327,359,360,387,388`.
    These are **reachable through the bracket arm** — an earlier F4 note calling
    them dead was wrong.
  - `PARTICIPANTS_COLUMNS` (`:153`) has an `opts.i18n` override at `:168`, so
    confirm at implementation time whether `exportChrome` actually supplies it
    or the English default is silently winning. The same check applies to
    `timetableColumns` and `rotaColumns`.

**Approach.** Widen `BuildOpts["i18n"]` with the missing fields (an
`entrantTbd` for the bracket arm, plus whatever the audit above finds unwired)
and populate them in `exportChrome()`
(`apps/web/src/server/usecases/exports.ts:338`), which already resolves the org
locale through `msgFor`. English literals stay in the engine as the no-i18n
fallback — that is a deliberate boundary, not debt.

**Do not** give the engine a locale, a dictionary, or an `Accept-Language`
reader. `apps/web` has no server-side i18n either; the org's `default_locale`
is the only defensible locale for a document nobody is viewing, and both
`exports.ts:58-67` and the calendar route already say so in comments.

---

## 3. Wave 2 — the English prose on documents organisers hand out

`exports.ts` localized its bracket chrome in F4 and left the surrounding prose
untouched, so a French scoresheet has French round names and English form
lines.

- Scoresheet form lines and signature labels ("Referee", "Captain — ").
- The Page-playoff description, and every section description.

Route them through the existing `slotLookup` / `msgFor` path. New keys go in
all four locale dictionaries.

**Both fixture paths.** The bracket poster runs its **own** fixture query in
the `exports.ts` bracket arm and never calls `exportFixtures`. F4's first pass
missed it for exactly that reason. Anything changing how exported fixtures
resolve must touch both or it silently covers one.

**Adding a key is not finished until `npm run i18n:gen-keys` has run and
`apps/web/src/lib/i18n-keys.ts` is committed.** `i18n:check` and the parity
script both stay green against a stale generated file, because they compare the
locales to each other. Only CI's drift gate sees it. F4 lost a CI cycle to
this and `#618` hit it the same day (`315ef26c0`).

---

## 4. Wave 3 — calendar correctness

**The `?entrant=` feed drops every day-one fixture by construction.** The
predicate is `!entrantId || f.home_entrant_id === entrantId || f.away_entrant_id === entrantId`.
An unresolved fixture has both ids null, so a subscribing player never receives
the final they are heading toward. "A player can subscribe to their own route
through the draw" is the product claim day-one fixtures exist to deliver, and
it is not delivered today. Fix: keep a fixture whose *slot label* cites that
entrant, alongside the id match. The unfiltered feed already handles these
correctly — only the per-entrant filter is wrong.

**`registrationIcs` (`registrations.ts`) hand-rolls a second VCALENDAR.** Not an
injection risk (§1), but it diverges from `buildIcs` (`lib/public-site.ts:92`)
in ways that matter: no `foldLine` (so a long competition name emits a line
over 75 octets, invalid per RFC 5545 §3.1), no `CALSCALE`/`METHOD`, and a
hardcoded English `DESCRIPTION` ("Registration for X (status)"). Replace the
body with a `buildIcs` call and localize the description. Its existing test
(`registrations.test.ts:779`) asserts only `toContain("BEGIN:VCALENDAR")` and
will pass through the swap either way — ship a folding test that fails first.

**Triage the survivors.** `org-posts.ts:533,534,580,581` and
`match-reports.ts:224` still hold bare `?? "TBD"`. Determine reachability with
a day-one fixture for each; localize the reachable ones, comment the rest with
why they cannot be reached.

---

## 5. Wave 4 — the day-one full-draw poster

Owner ruling: **a new page on the public `poster.pdf`**, not a mode of the
staff-facing bracket export.

`src/app/(public)/shared/[orgSlug]/[competitionSlug]/poster.pdf/route.ts` is
today a single A4 pdfkit page — org name, competition name, dates, a 320pt QR,
"Scan to follow live". It is public, unauthenticated, `revalidate = 300`, and
already the artifact an organiser pins to a wall. The draw becomes page 2+.

It is also, unlisted by anyone, the same defect class as waves 1–3: `"Scan to
follow live"`, `"Live scores · fixtures · standings — no app needed"` and
`toLocaleDateString("en-GB", …)` are hardcoded. Fix them in the same pass —
the poster is the one export whose audience is least likely to read English.

The existing landscape bracket poster in the `exports.ts` bracket arm stays as
it is. It is org-authenticated and a spectator cannot reach it; it is not the
wall poster and is not being replaced.

This is the only wave that is new UI rather than cleanup: it needs the
frontend-design bar and print output inspected as a rendered PDF, not asserted
by byte count.

---

## 6. Wave 5 — the paywall defects

Both are missing UI rather than wrong behaviour, and F5 is already touching
user-facing strings and dictionaries, so the i18n cost is shared.

- `AddStageForm` renders a plain error banner where a paywall card belongs.
- `division-settings.tsx`'s `buildTemplateStages` call has no
  `PAYMENT_REQUIRED` handling at all.

Note `lib/seeding-error.ts`'s scope note forbids adding to its code list; a new
resolver, if one is needed, goes in `lib/` — not beside either caller, because
a resolver placed beside a caller closes an import cycle when two surfaces
share it (`#580`).

---

## 7. Wave 6 — the inherited test debt

Worked from the F3–F5 design §5 table, top to bottom, with these amendments:

- **F1's owed smoke check** — round naming and byes. Deferred at F1 to avoid
  conflicting with F2's `smoke.ts` conversion, which has since landed.
- **Three tautological tests** — `catalog.test.ts:68`,
  `format-templates.test.ts:200`, `format-gallery.test.ts:90` assert
  `not.toHaveProperty("qualification")` on a type that no longer has the field.
  They would pass if the code under test were deleted. **Replace the
  assertion; do not delete the test** — assert the `progression` shape that
  should be there.
- **Multi-source fuzz** — the property harness builds single-source specs only,
  by its own comment at `testkit/simulation.ts:796-797`. Multi-source is the
  newest code in the programme and has directed tests but no fuzz.
- **Board payload budget** — `e2e/board-v3.spec.ts:228`. The inherited "roughly 250003
  against 250000" is arithmetic, not measurement. **Measure first.** Owner
  ruling: if the measurement shows `main` is already over the ceiling, report
  the real number, leave the gate untouched, and raise it as its own issue.
  F5 does not silently absorb a payload regression it did not cause, and does
  not open-endedly shrink the payload.
- **Weak `seeded_map` assertion** — `progression.test.ts:157` checks only
  `placed[0]` of four unclaimed seats; an implementation slicing by position
  rather than filtering by claimed key passes byte-identically.
- **Stale blocker comment** — `format-catalogue.test.ts:67-89` says it stays red
  until Task 6 converts and forbids regenerating the snapshot. Task 6 landed;
  it passes 3/3. Delete the comment.
- **Missing `best_nth` cross-pool tie-flagging test** — the deleted
  `stage-seeding.test.ts` had one; the shared tie block at
  `progression.ts:521-527` is proven via `rank_range` only.

---

## 8. Exclusions

- `packages/engine/src/sport/**`, the fidelity-tier scale, the scoring pad, the
  `StageKind` enum.
- `ticketRegistrationRows` is **not** part of P5 and never was — it selects
  `registrations.display_name`/`ref_code` and joins neither `fixtures` nor
  `entrants`. Verified twice by two reviewers. Do not "fix" it.
- The staff-facing landscape bracket poster (§5).
- `standings.carry_over` — that is F6 / `#625`.

---

## 9. Verification

- **`turbo run lint typecheck` from the repo root is the CI gate.**
  `npm run lint` alone is not, and `rtk` hides lint output entirely — use
  `rtk proxy` and read `✖ N problems`.
- Run vitest with `--reporter=json --outputFile=<path>` and judge only
  `numPassedTests` / `numTotalTests`. Readable summaries print `PASS(0)
  FAIL(0)` for a suite that failed to **collect**.
- All four test types per task: unit, e2e, smoke, regression. Every change
  ships a test that fails without it.
- `.github/workflows/e2e.yml` is **live on pull requests** — read it for the
  current job shape rather than trusting any written count.
- The poster (§5) is verified by opening the rendered PDF. The paywall cards
  (§6) are verified by screenshot at 1280, 320 and 768 with no horizontal page
  scroll at any width.
- **Verify by looking, not by counting.** Every serious defect in F1–F4 was
  silent: a dropped key returning 200, a filter matching nothing, a CHECK
  constraint accepting what it was written to reject, a test asserting a defect
  approvingly. None crashed; all passed their suites. Three of F5's own
  inherited premises (§1) were wrong for the same reason.
- **Before writing the task list**, grep `apps/web/src`, `scripts/`,
  `apps/web/e2e/`, `db/` and `packages/` in ONE pass for every symbol the
  session touches. F2's unowned work surfaced in four separate waves because
  each sweep was scoped to whatever that author happened to be editing.
