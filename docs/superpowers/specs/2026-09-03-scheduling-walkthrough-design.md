# Design: the scheduling walkthroughs

Owner-requested 2026-09-03. Status: **draft, awaiting owner review.**

## Problem

An organiser's scheduling day spans thirteen actions across six tabs. Every
one of them has code, most have a test, and **not one test drives the whole
journey**. The gaps are exactly the shape this repo has shipped defects
through before: a control that renders but is never chosen, a seam only ever
crossed by an API call, a guard that exists on three write paths and is
missing from the fourth.

The organiser's scheduling home is `/o/{org}/c/{comp}/d/{div}/schedule`
(`apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/schedule/page.tsx`),
whose `TABS` at line 57 are `board | health | settings | constraints |
officials | history`. This is NOT `?tab=fixtures` — that is the division run
sheet (`stages-panel.tsx`), and it owns only two of the thirteen actions
(per-fixture court/time and the stage court-tag panel).

## Goals

- One walkthrough per journey, in `apps/web/e2e/walkthrough/`, obeying that
  folder's rule: setup may use the API to REACH a state; every step that IS
  the thing under test is tapped, typed or submitted through the UI.
- Close the four surfaces nothing has ever tapped: officials **assign**,
  blackout **creation**, required court **tags**, and the settings-plus-
  constraints screen as one journey.
- Fix the freeze hole the scouting found, with a test that fails without it.
- Give the constraints, settings, history and officials panels the
  `data-testid` hooks they entirely lack.

## Non-goals

- No redesign of any scheduling screen. This wave observes and tests; the
  only production changes are additive testids and one server-side guard.
- No new scheduling capability. Nothing here adds a constraint type, a
  blackout scope, or a lifecycle state.
- Not the AI scheduling console (`ai-console.tsx`) — `ai-architect.spec.ts`
  already drives it and is out of scope here.

## The surface map

Established by scouting on 2026-09-03. Every line below was opened, not
grepped.

| Action | Control | Route |
|---|---|---|
| Auto-schedule | `schedule-board.tsx:1273` `schedule-auto` | `?tab=board` |
| Re-flow / Improve | `schedule-board.tsx:1294`, `:1312` | `?tab=board` |
| Required courts | `shared/court-multi-picker.tsx` (aria-label only) | `?tab=settings` |
| Required court tags | `stages-panel.tsx:2035` `stage-court-tags` | `?tab=fixtures` |
| Settings (hours, match/gap minutes) | `board/settings-panel.tsx` | `?tab=settings` |
| Constraint matrix | `constraints-panel.tsx:588` | `?tab=constraints` |
| Blackout editor | `constraints-panel.tsx:822-940` | `?tab=constraints` |
| Wait report | `constraints-panel.tsx:1008-1021` | `?tab=constraints` |
| Capacity precheck | `board/capacity-card.tsx`; block at `stages-panel.tsx:1066` | `?tab=settings` |
| Officials propose | `officials-panel.tsx:308` | `?tab=officials` |
| Officials apply | `officials-panel.tsx:333` | `?tab=officials` |
| Officials manual assign | `officials-panel.tsx:531` (`<select>`) | `?tab=officials` |
| Officials invite | `officials-directory-panel.tsx:293` | directory |
| Save point | `history-panel.tsx:260` | `?tab=history` |
| Restore | `history-panel.tsx:394` | `?tab=history` |
| Clear schedule | `history-panel.tsx:449-469` | `?tab=history` |
| Freeze | `schedule-board.tsx:1390` `board-freeze` | `?tab=board` |
| Publish | `schedule-board.tsx:1415` `board-publish-schedule` | `?tab=board` |

Domain layer:

- Placement entry point: `packages/engine/src/scheduling/build.ts:1152`
  `buildSchedule`. CI builds the placement image, so CP-SAT is live on the
  walkthrough leg; greedy is the fallback path.
- Constraint vocabulary (`packages/engine/src/scheduling/constraints.ts:86`):
  `min_rest_minutes`, `max_fixtures_per_day`, `fixture_on_weekday`,
  `fixture_on_date`, `not_before`, `not_after`. Scopes at `:30`:
  `competition`, `division`, `entrant`, `person`, `pool`, `every_entrant`,
  `every_person`. There is deliberately no `round` scope.
- Required courts are **tag-based, never a count**: `divisions
  .required_court_tags text[]`, effective set = division ∪ stage ∪ round,
  resolved by `candidate-courts.ts:80`.
- Blackouts have two homes: official days in `official_availability`
  (`V284`, one row per blacked-out date, status fixed at `unavailable`), and
  court/venue windows inside `schedule_settings.config.blackouts[]` — an
  element carrying a `court` key blacks out that court, one without is
  venue-wide. There is no team-scoped blackout.
- Freeze is `divisions.schedule_locked boolean` (`V244`), not a status enum.
  Publish is `competitions.status → 'published'`.

### "Frozen" means three unrelated things

Worth stating because a fresh session will conflate them:

1. `divisions.schedule_locked` — the schedule freeze in this document.
2. The billing/entitlement freeze on an over-quota org
   (`competitions.ts:320` `assertCompetitionNotFrozen`).
3. Nothing in any status check-constraint. `competitions.status` is
   `draft|published|live|completed|archived`; no `frozen` member exists.

## Findings already established

**F1 — clear-schedule ignores the freeze. Confirmed in code; to be confirmed
live.** `divisionLockState` (`schedule.ts:531`) reads `schedule_locked`, and
four write paths refuse a frozen division with a 422: single apply
(`schedule.ts:2524`), fixture move (`:2901`), AI plan (`schedule-ai.ts:912`),
joint apply (`competition-schedule-apply.ts:419`). `clearScheduleScoped`
(`history.ts:659`) takes the advisory lock, checks the division exists, and
never asks. Its route (`api/v1/schedule/clear/route.ts`) does RBAC only. The
UI gates the Danger zone on `canEdit` alone (`history-panel.tsx:438`), so the
button is visible and enabled on a frozen division.

Customer consequence: an organiser freezes a published timetable precisely so
it cannot move, then wipes every unlocked slot in it with one button. Owner
ruled 2026-09-03 that this wave fixes it.

**F2 — the Danger zone is hardcoded English.** `history-panel.tsx:440`
(`"Danger zone"`), `:441-444` (the explanatory copy) and `:468`
(`"Clear schedule…"`) are literals, not dictionary keys, while the confirm
dialog beside them correctly uses `msg("confirm.clearSlots.*")`. Violates the
four-locale rule.

**F3 — the officials assign select is never chosen.** `officials-directory
.spec.ts` asserts the `<select>` at `officials-panel.tsx:531` is visible and
stops there. Reachability is not a value: nothing pins which official an
organiser actually lands on, nor that the assignment persists.

**F4 — no UI has ever created a blackout.** `ai-architect.spec.ts` and
`board-v3.spec.ts` both PUT blackouts through the API and then assert a
downstream render. The editor at `constraints-panel.tsx:822-940` is untapped.

**F5 — required court tags are wholly API-driven.** `court-tags-scheduling
.spec.ts` sets `required_court_tags` only via `apiJson`, and carries a
`test.fixme` at `:276` reading "court picker not built yet".

## Design

Two specs, both in `apps/web/e2e/walkthrough/`, both in the existing
`walkthrough` Playwright project. No config change: `WALKTHROUGH =
/[\\/]e2e[\\/]walkthrough[\\/]/` already selects anything added to that
folder, and `e2e.yml`'s walkthrough leg already runs it at `--workers=3`.

Two files rather than one because the officials journey needs a second
browser context for the invited official, and because `describe.configure({
mode: "serial" })` aborts every remaining test in a file after the first red —
splitting bounds that blast radius.

### Spec 1 — `scheduling-organiser-day.spec.ts`

One division, one continuous serial journey. Setup via API: org, competition,
division, entrants, a venue with four courts across two venues (so
venue-qualified naming is exercised), a generated league stage.

Tapped, in order:

1. `?tab=settings` — choose the required courts in the multi-picker; set
   match minutes, gap minutes and the play-hours window.
2. `?tab=fixtures` — set the stage's required court tags through
   `stage-court-tags`, closing F5.
3. `?tab=constraints` — set `min_rest_minutes` and `max_fixtures_per_day`
   through the matrix; read the values back from `schedule_settings.config`.
4. `?tab=constraints` — create a court blackout window in the editor,
   closing F4. Assert the board paints it (`board-grid.tsx:260`
   `data-blackout`).
5. `?tab=constraints` — run the wait report; assert it names the entrant it
   claims, not merely that a report appeared.
6. `?tab=settings` — read the capacity precheck; assert its verdict against
   the numbers just entered, derived from the settings rather than a typed
   constant.
7. `?tab=board` — `schedule-auto`. Assert `schedule-result-strip` and
   `schedule-result-provenance`, and that no fixture lands inside the
   blackout window created at step 4.
8. `?tab=history` — create a named save point.
9. `?tab=history` — clear the schedule; assert the board is empty and the
   skipped counts match the locked/decided rows.
10. `?tab=history` — restore the save point; assert every slot returns to
    the exact time and court it held at step 7.
11. `?tab=board` — `board-freeze`.
12. **The F1 gate**, in two halves, because the fix closes the hole at both
    layers. UI half: with the division frozen, `?tab=history`'s clear button
    is present but disabled and carries its reason. API half: the spec POSTs
    `/api/v1/schedule/clear` directly and expects 422 — the UI half alone
    would pass against a server that still wipes the board, since a disabled
    button proves only that this client declines to ask. Both halves fail on
    `main`.
13. `?tab=board` — `board-publish-schedule`, then `board-start-division`.

Closes at the terminal state, per the standing rule that a walkthrough runs
through to the end.

### Spec 2 — `scheduling-officials-handoff.spec.ts`

The two-person seam. Setup via API reaches a scheduled division.

Tapped, in order:

1. Organiser invites an official from the directory
   (`officials-directory-panel.tsx:293`).
2. The claim link is followed **from the page that emits it**, never
   constructed — a dead link stays green when a test builds the URL itself.
3. The official sets an unavailable day in their own blackout editor
   (`me/officiating-lane.tsx:83`), writing `official_availability`.
4. The organiser proposes (`officials.propose`) and applies
   (`officials.apply`).
5. The organiser assigns manually through the `<select>` at
   `officials-panel.tsx:531`, closing F3. Pin **which** official the control
   opens at and which one is chosen, not merely that a choice was possible.
6. The official accepts from `/me`
   (`officiating-lane.tsx:189`), and `fixture_officials.response` agrees.
7. Assign the same official on their blacked-out day; assert the UI says so
   (`officials.unavailableOn`, `officials-panel.tsx:502`) rather than
   accepting silently.

### Production changes

**The F1 fix.** `clearScheduleScoped` gains the same guard its four sibling
write paths carry:

```ts
const lockState = await divisionLockState(tx, divisionId);
if (lockState.frozen) {
  throw new HttpError(422, "the division schedule is locked — unlock it to edit");
}
```

placed after the existence check and before `clearableFixtures`. Same status
code and same message as `schedule.ts:2525`, so the five paths refuse on
identical terms.

The UI **disables** the Danger-zone button when the division is frozen and
says why beside it — disabled rather than hidden, because a vanished control
reads as a missing feature while a disabled one with a reason teaches the
organiser that unfreezing is the way back. That reason string is new
user-facing copy and owes all four locales.

**The F2 fix.** The three literals move to dictionary keys in all four
locales, beside the `confirm.clearSlots.*` keys that already exist.

**Testids.** Additive `data-testid` attributes, no behaviour change, on the
controls the two specs drive: the court multi-picker and its options, the
settings fields, each constraint row in the matrix, the blackout editor and
its add/remove, the wait-report trigger and its result, the save-point input
and button, each checkpoint row's restore, the Danger-zone clear button, the
officials propose/apply/assign controls, and the official's blackout editor.
Selecting by translated button text is what the suite does today; it breaks
under any non-default locale and reds on a copy change.

## Testing

Per the standing four-types rule, the F1 fix ships all four:

- **Unit** — `clearScheduleScoped` refuses a frozen division and still
  clears an unfrozen one. Derived from `divisionLockState`, not a literal.
- **E2E** — step 12 of spec 1.
- **Smoke** — the frozen-clear 422 joins the smoke run's scheduling
  section, so a deploy that loses the guard is caught without the e2e leg.
- **Regression** — a mutation: delete the new guard and confirm step 12 and
  the unit test both go red. Per the folder's own rule, both specs are
  mutated until they fail before they are trusted.

Two guards now cover the clear path (server 422, UI hiding the button). They
must be mutated **one at a time**, or each is untested behind the other.

## Verification

The owner's order, agreed 2026-09-03: **drive it by hand first, then
codify.** A prod build with the placement service up, both journeys driven in
a real browser, screenshots at 1280, 768 and 320, findings written to
`docs/superpowers/specs/2026-09-03-scheduling-walkthrough-findings.md` before
either spec is written. Anything found there is a finding to record, not a
blocker — the brief is a hypothesis.

Standing bars that apply:

- No horizontal page scroll at any of the three widths, and the no-scroll
  gate is not itself a layout check — read what renders.
- At phone width compare the visible control SET, not box sizes. Six tabs of
  dense organiser tooling is exactly where a groomed shrink hides.
- Both specs print what they saw next to each assertion; a green gate on the
  wrong page state is worse than a red one.
- Confirm the runner COLLECTED both files — `--reporter=json` and
  `.testResults[].name`, never a `PASS(0) FAIL(0)` summary.
- Run whole spec files, never a `-g` slice.

## Risks

- **The walkthrough leg is already the workflow's floor** (~300s on CI).
  Two more specs at roughly two minutes each run concurrently on the leg's
  three workers, so the leg's wall clock should hold; measure it rather than
  assume it.
- **Greedy versus CP-SAT.** With the placement service down, step 7 takes
  the greedy path and can produce a different board. Assertions there must
  hold for either producer — assert the blackout is respected and the strip
  reports a provenance, never a specific arrangement.
- **`startAt` is not the solver's floor.** A CP-SAT board legitimately
  places earlier than `config.startAt`. Do not assert otherwise.
- **Three placement sides must agree** — lattice, greedy, verifier. This
  wave adds no constraint, so it inherits the invariant rather than testing
  it.
- **Testid churn.** Adding testids touches files three other live programmes
  are editing (`schedule-board.tsx` alone took six commits in a fortnight).
  Additive attributes conflict rarely, but rebase before the final gate.
