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
// specifically must not move into a per-stage child: it broke pre-existing
// tests that locate the auto-schedule button by testid). Task 5 folds this
// into a phone bottom sheet and a later task moves the auto-schedule CTA
// onto it — both depend on this shape staying prop-driven.
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
    </>
  );
}
