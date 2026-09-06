"use client";

// Competition Desk W3 (2026-09-06, task 2): the stage rail. Owner ruling —
// all stage chrome leaves the fixtures sheet. This is the first slice: the
// three stage-header action controls (Generate/Pair next, Complete stage,
// Delete stage), moved verbatim out of stages-panel.tsx's own header render.
//
// PRESENTATIONAL ONLY, deliberately: this component receives everything it
// renders as props and calls no `use*` DATA hook of its own (useMsg is a
// plain context read, not a data fetch, and is fine — see stages-panel.tsx's
// own `useCapacityReportsByStage` comment for why a data-fetching hook
// specifically must not move into a per-stage child). Task 5 folds this into
// a phone bottom sheet.
//
// Task 4 first attempt moved the auto-schedule CTA here and reverted: it
// reddened `stages-panel-auto-schedule-seq.test.tsx` and
// `stages-panel-result-strip.test.tsx`, which locate the button by testid
// through `renderIsland`'s default `walk()` — and `walk()` only recurses an
// element's `.props.children`, never invoking a nested function component's
// own render, so anything inside `<StageRail>`'s output was invisible to it
// from `StagesPanel`'s root, inline render or slot prop alike (full
// investigation in git history / task-4-report.md).
//
// Fix round 1 (owner ruling): fixed the TEST HELPER instead of abandoning
// the move. `_hook-harness.tsx` grew `expandWithHooks`, a way to expand a
// hook-using child (this file's own `useMsg()`) from a custom `expand`
// passed to `renderIsland` — mirroring the repo's existing hookless
// `expandRows`/`expandPanel` pattern, but installing a minimal `useContext`-
// only dispatcher for the duration of the call so a real hook doesn't hit
// React with no dispatcher active. Both test files now use it. The CTA
// below is the result — see its own comment for the shape.
import { useMsg } from "@/components/i18n/dict-provider";

interface StageRow {
  id: string;
  seq: number;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  progression: Record<string, unknown> | null;
  status: string;
}

export interface StageRailProps {
  stage: StageRow;
  canEdit: boolean;
  busy: string | null;
  fixtureCount: number;
  deletable: boolean;
  onAct: (stageId: string, action: "generate" | "complete" | "delete") => void;
  onDelete: (stage: { id: string; name: string }) => void;
  /** Stage id whose inline "Add match" form is currently open (owned by the
   *  panel's `addingTo` state) — used only to reflect the trigger's disclosure
   *  state via `aria-expanded`, the same convention `StageCourtTagsEditor`'s
   *  own toggle uses. */
  addingTo: string | null;
  onToggleAddMatch: (stageId: string) => void;
  /** Whether this stage's kind is in `ADHOC_STAGE_KINDS` — computed by the
   *  panel, not the rail, so the rail stays presentational. */
  adhoc: boolean;
  /** `StageCourtTagsEditor` stays mounted by the panel and is handed down as
   *  an already-built element — a slot, not a component reference — so the
   *  rail keeps owning no data hook of its own. */
  courtTagsSlot: React.ReactNode;
  /** Task 4, fix round 2 (ruling T4-B) — the unscheduled-count badge,
   *  already-built by the panel, same `courtTagsSlot` shape and same reason:
   *  a non-editing viewer must still see this badge (it carried NO `canEdit`
   *  gate in its previous, pre-rail position), but this component returns
   *  `null` outright for `!canEdit` — so the panel builds the element ONCE
   *  and mounts it in exactly one of two places: here when `canEdit`, or
   *  inline in its own tree when not (see stages-panel.tsx's own comment at
   *  that second site — same pattern Ruling T3-A already set for
   *  `courtTagsSlot`, never a second shape for the same problem). `null`
   *  when there is nothing unscheduled — hides the whole pinned section
   *  (badge + CTA + blocked reason), matching the panel's own former
   *  `unscheduled.length > 0` gate byte-for-byte, now expressed as "the slot
   *  itself is absent" rather than a separate count prop. */
  unscheduledBadgeSlot: React.ReactNode;
  /** Task 4 — the D2 capacity pre-check verdict for THIS stage, already
   *  resolved to a plain value by the panel's own `capacityGateBlocks`
   *  predicate and `msg("schedule.capacity.blockedReason")` call. The rail
   *  owns no `useCapacityReportsByStage` subscription of its own — see this
   *  file's own header, and stages-panel.tsx's comment above its one call to
   *  that hook. `null` (or `{ blocked: false, reason: null }`) never blocks
   *  — same fail-open contract `capacityGateBlocks` documents. */
  capacityBlocked: { blocked: boolean; reason: string | null } | null;
  /** Task 4 — fires the "Auto-schedule remaining" propose+apply pair for
   *  this stage. The rail only ever calls this with `stage.id`; it holds no
   *  request state of its own (`busy` above is what disables it mid-flight,
   *  same prop the other rail buttons already read). */
  onAutoSchedule: (stageId: string) => void;
}

export function StageRail({
  stage,
  canEdit,
  busy,
  fixtureCount,
  deletable,
  onAct,
  onDelete,
  addingTo,
  onToggleAddMatch,
  adhoc,
  courtTagsSlot,
  unscheduledBadgeSlot,
  capacityBlocked,
  onAutoSchedule,
}: StageRailProps) {
  const msg = useMsg();

  if (!canEdit) return null;

  return (
    <>
      {stage.status !== "complete" && (
        <>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              // P6/D4b task B, scope item 2 — REVERSED (fix round 3,
              // Critical 1, whole-branch review): this click used to
              // be gated behind a "you'll lose N fixtures" confirm
              // dialog whenever stageFixtures.length > 0. That
              // premise was never checked against the code and is
              // false — generateStageFixtures (stages.ts) is
              // ADDITIVE ONLY. It builds `byKey` from the stage's
              // existing fixtures and inserts only the generated
              // rows missing from it (stages.ts:997-1031); any
              // existing fixture that no longer matches the current
              // rules is left in place, untouched, not discarded.
              // The repo's only `delete from fixtures` are
              // history.ts's checkpoint restore and a demo seed —
              // neither is this code path. So the dialog blocked a
              // routine, safe action (an organiser adding a late
              // entrant, then clicking Generate again) behind a
              // false data-loss warning.
              //
              // Deliberately NOT replaced with a truthful-but-vague
              // "this won't remove stale fixtures" disclaimer either:
              // there is no client-side way to tell whether any
              // existing fixture actually IS stale (that diff is
              // engine-only, server-side, out of this task's scope —
              // same reason the old dialog computed a client-side
              // "blast radius" instead of the real diff in the first
              // place). A disclaimer with no computed fact behind it
              // would just be new boilerplate to click through on
              // every regenerate, forever, in place of one that
              // named specific (if wrong) numbers. Regeneration is
              // simply a normal, unguarded action now, same as the
              // common first-generate case always was.
              onAct(stage.id, "generate");
            }}
            data-testid="stage-generate"
            className="btn btn-ghost px-3 py-1.5 text-xs"
          >
            {busy === stage.id
              ? msg("schedule.working")
              : stage.kind === "swiss"
                ? msg("schedule.pairNext")
                : msg("schedule.generate")}
          </button>
          {fixtureCount > 0 && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onAct(stage.id, "complete")}
              data-testid="stage-complete"
              className="btn btn-primary px-3 py-1.5 text-xs"
            >
              {msg("schedule.complete")}
            </button>
          )}
        </>
      )}
      {deletable && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => onDelete({ id: stage.id, name: stage.name })}
          data-testid="stage-delete"
          className="btn btn-danger px-3 py-1.5 text-xs"
        >
          {msg("schedule.delete")}
        </button>
      )}
      {stage.status !== "complete" && adhoc && fixtureCount > 0 && (
        // Task 3 — trigger only. `AddMatchForm` deliberately stays mounted in
        // stages-panel.tsx: it reads `boardSlotOptions`, which also feeds
        // `<RunSheet>`, so hoisting the form itself here would mean building
        // a second copy of that derivation. Do not "finish the job" by moving
        // the form too — that would break the run sheet's own slot options.
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => onToggleAddMatch(stage.id)}
          aria-expanded={addingTo === stage.id}
          data-testid="stage-add-match"
          className="btn btn-ghost px-3 py-1.5 text-xs"
        >
          {msg("stage.addMatch.button")}
        </button>
      )}
      {courtTagsSlot}
      {/* Task 4 — the pinned unscheduled section (badge + auto-schedule CTA
          + capacity blocked reason), moved onto the rail verbatim: same
          classNames, same gating, same testids. The D2 capacity verdict
          itself is computed once in stages-panel.tsx (its comment above
          `useCapacityReportsByStage` explains why that subscription cannot
          move here) and handed down already-resolved as `capacityBlocked`.
          Fix round 2 (T4-B): the badge itself is a slot, not a value — see
          `unscheduledBadgeSlot`'s own doc comment above. */}
      {unscheduledBadgeSlot && (
        <div className="border-b border-dashed border-slate-200 bg-slate-50/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {unscheduledBadgeSlot}
            {canEdit && stage.status !== "complete" && (
              <button
                type="button"
                data-testid="stage-auto-schedule"
                disabled={busy !== null || (capacityBlocked?.blocked ?? false)}
                onClick={() => onAutoSchedule(stage.id)}
                className="btn btn-primary min-h-11 px-3 py-1 text-xs"
              >
                {busy === stage.id ? msg("schedule.working") : msg("schedule.unscheduled.cta")}
              </button>
            )}
          </div>
          {capacityBlocked?.blocked && (
            <p data-testid="stage-auto-schedule-blocked" className="mt-1.5 text-xs text-red-600">
              {capacityBlocked.reason}
            </p>
          )}
        </div>
      )}
    </>
  );
}
