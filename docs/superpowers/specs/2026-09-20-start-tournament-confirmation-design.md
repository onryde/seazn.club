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

Tap Start → dialog opens → it fetches `POST /api/v1/divisions/{id}/schedule/validate`
(read-only, `requireResourceAuth(..., "read")`, same conflict source as the
publish gate) → renders consequences, plus a conflicts section when the preview
returns any → Confirm → the existing `start()` runs unchanged.

The reactive `schedule-gate-dialog` **stays**. The preview is advisory, not
authoritative: `startDivision` runs its own gate AFTER writing rolling times
inside its transaction, "so it judges the board this call is actually about to
open scoring on", and a concurrent organiser can move a card between preview and
commit. So the backstop keeps its job; this dialog only stops the refusal being
the first time anyone hears about a clash.

### Copy rules

- When the preview finds **no** conflicts, say **nothing** about conflicts.
  Never assert "no conflicts found" — that claim can be false by the time the
  Confirm lands, and a dialog that lies once is not read again.
- When the preview **fails** (network, 5xx), show the consequences and omit the
  conflicts section. A failed preview must never block Start — the server gate
  is the real one.
- Blocking conflicts are shown as blocking; the Confirm button still submits
  (the server refuses and the existing dialog opens). Do NOT client-side-disable
  Confirm on a preview result — the preview is advisory, and a stale blocking
  preview would strand the organiser with no route out.

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
  until confirmed; Cancel fires no request; the conflicts section renders from
  the preview; the ladder/americano carve-out omits the entrants line; a failed
  preview still allows Start.
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
