# Start Tournament — confirmation dialog

**Owner-approved 2026-09-20.** Option A (always confirm), owner/admin as today,
conflicts previewed inside the same dialog.

## The problem

`launch-actions.tsx:109` is `onClick={() => void start()}`. One tap, no
confirmation, on the most irreversible button in the product. The only dialog
that exists today (`board/schedule-gate-dialog.tsx`) is **reactive** — it appears
after the server refuses with `PUBLISH_BLOCKED` or `PUBLISH_UNACKNOWLEDGED`. A
clean board means the organiser is never told anything before going live.

## What Start actually does

`startDivision` (`usecases/schedule.ts:3701`), in order:

1. `validateScheduleIn` → `assertPublishable` (may refuse).
2. **Publishes the timetable** if `status === "setup"` — the code calls this
   "the moment the timetable goes in front of players, and the event is the only
   record anywhere that it did" (`history-panel.tsx` renders it).
3. `update divisions set status = 'active'`.
4. Appends a `division_started` division event.

## What is locked, and WHEN — verified, not assumed

This table is the dialog's content. Every row was read out of the tree on
2026-09-20; do not restate it from memory in a later session.

| Thing | Locked at | Evidence |
| --- | --- | --- |
| **Entrants** | **Start** | `entrants.ts:296-305` — 422 "This tournament has started — the entrant list is locked." **Withdrawals still work.** `ladder`/`americano` are EXEMPT (open-window formats take late joiners by design, Jul3/08 §6). |
| **Format / stage graph** | **Generate**, NOT start | `replaceStages` (`stages.ts:455-459`) 409s `FORMAT_LOCKED` once ANY fixture row exists. Under the #803 shell model the first Generate mints shells for every round, so format is normally locked well before Start. |
| **Match rules** | **Per stage, progressively** | `stage-rules.ts:40-48` — a stage locks when any of its fixtures has `config_snapshot is not null OR exists(score_events)`. A stage that has not begun stays editable AFTER start. Monotonic on purpose: `fixtures.status` moves backwards when a `core.start` is voided. |
| **Swiss round count** | **Generate** | Lives in `stages.config`, written only via `createStages`/`replaceStages`, so it rides the format lock. **This contradicts the owner's 2026-09-20 ruling** that rounds stay changeable until start — tracked separately, NOT in this wave. |

The common misconception this table corrects: start does **not** lock the
format (it is already locked) and does **not** lock the rules (they lock later,
one stage at a time).

## The conflict split — do NOT change it

`assertPublishable` (`schedule.ts:3550-3573`) tests blocking FIRST and
independently of the acknowledge flag, because folding them "turns
`acknowledge_warnings` into an override for a physically impossible board."

Blocking (`isBlockingConflict`, `packages/engine/src/scheduling/calendar.ts:319`)
is exactly four cases, all physical impossibilities: `court` double-booking
(minus the `court_tag_mismatch` / `outside_court_hours` / `stranded_fixture`
carve-outs), `person_overlap`, `window`, and `order` with `direct === true`.
Everything else is warn-only and acknowledgeable.

**This wave does not touch that split.** The dialog reports; it never overrides.

Note also that `validateScheduleIn` builds assignments only from fixtures
carrying BOTH `scheduled_at` and `court_id` — an empty or half-slotted board
yields zero conflicts, which is how most divisions start.

## Design

### Flow

Tap Start → dialog shows the consequences list → Confirm → the existing
`start()` runs unchanged.

That is the whole flow. **Owner amendment, 2026-09-20 (supersedes the first
draft of this section):** the dialog does NOT preview schedule conflicts. It
does not call `/api/v1/divisions/{id}/schedule/validate`, renders no conflicts
section and has no loading state.

Schedule conflicts are not this dialog's concern. The reactive
`board/schedule-gate-dialog.tsx` already handles them when the server refuses
with `PUBLISH_BLOCKED` / `PUBLISH_UNACKNOWLEDGED`, and it stays exactly as it
is. A preview here would have been a second, advisory source of truth for
something the server already decides authoritatively — `startDivision` runs its
gate AFTER writing rolling times inside its own transaction, so a preview can
disagree with the commit anyway.

### Copy rules

- The dialog states consequences only. It makes no claim about the schedule,
  in either direction — no "no conflicts found", no clash list.
- Nothing in the dialog is conditional on a network result, so there is no
  failure mode in which it can wrongly block Start.

### Content

Title: start this tournament?
Lead: the timetable goes live to players now.
Then, as a list:
- Entrant list closes. Withdrawals still work; no one new can be added.
  (Omit this line entirely for a division whose stages are all `ladder` /
  `americano` — those take late joiners, so the line would be false.)
- The format is already locked — fixtures exist.
- Match rules stay editable for stages that have not begun. Once a stage's
  first match is scored, its format locks too.

Actions: Start tournament (primary) / Cancel.

### Permission

None owed. `/start` is already `requireResourceAuth(req, "division", id, "write")`
and `api-v1/auth.ts:206` defines `write` as owner/admin (or a write-scoped key).
The button is additionally gated on `canEdit` and on
`status === "setup" || "scheduled"`.

## Constraints

- **All four locale dictionaries** (en/es/fr/nl), never hardcoded English, then
  regenerate `i18n-keys.ts` (it is GENERATED — run the `gen-keys` script).
- Screenshot at **1280, 768 and 320**, no horizontal page scroll at any.
  Mobile-first; the dialog must be usable at 320.
- A test that fails without the change, for each of: the dialog blocks the POST
  until confirmed; Cancel fires no request; the ladder/americano carve-out
  omits the entrants line.
- `apps/web` vitest is `environment: "node"` — a unit test cannot see the
  dialog's wiring or focus behaviour. The e2e that covers Start must be
  re-run, not just the unit suite.
- Accessibility: focus trap, Escape cancels, focus returns to the trigger.
  Any new scrolling region owes `tabindex="0"` plus a role and accessible name
  or axe reds at SERIOUS.

## Out of scope

- The swiss-rounds freeze moving from Generate to Start (owner ruled it should;
  separate wave, touches the destructive shell path).
- Softening the per-stage rules lock into a warn-and-confirm (discussed, not
  ruled).
- Any change to `isBlockingConflict` or `assertPublishable`.
