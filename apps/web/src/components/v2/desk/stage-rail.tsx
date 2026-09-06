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
// into a phone bottom sheet.
//
// Task 4 tried and REVERTED moving the auto-schedule CTA here — recorded so
// a future attempt does not re-spend the same investigation. The failure is
// NOT about the capacity hook (that constraint is satisfied fine: the panel
// can compute a plain per-stage verdict and hand it down as a prop). It is
// `_hook-harness.tsx`'s `walk()`: `stages-panel.tsx` is driven through
// `renderIsland`/`walk` by `stages-panel-auto-schedule-seq.test.tsx` and
// `stages-panel-result-strip.test.tsx`, which locate the auto-schedule
// button by testid and click it to observe async state INSIDE StagesPanel —
// `renderToStaticMarkup` cannot do that (no interactivity). `walk()` only
// recurses into an element's `.props.children`; it never invokes a nested
// function component's own render function, so ANY element that ends up
// inside `<StageRail>`'s returned tree is invisible to it from
// `StagesPanel`'s root — proved empirically (moving the button here
// reddened exactly those two files' 3 tests, restored clean by reverting).
// Critically, this is true regardless of HOW the button reaches
// `<StageRail>`: building it inside this file's own render, or handing it
// in as an already-built element via a named prop (a `courtTagsSlot`-shaped
// "slot"), are the SAME shape from `walk()`'s perspective — it only ever
// reads `.props.children`, never any other prop, so a slot is exactly as
// invisible as an inline render. Calling `StageRail` as a plain function
// (skipping the JSX/component boundary, so its output inlines directly into
// `StagesPanel`'s own tree) is also unsafe: `StagesPanel` calls it once per
// stage inside `.map()` over a variable-length `stages` array, and this
// file's own `useMsg()` is a real hook — a variable per-render hook count
// corrupts React's hook list the moment a stage is added or removed, in
// production, not just in this harness. The only way to move the CTA here
// for real is to give `stages-panel-auto-schedule-seq.test.tsx` and
// `stages-panel-result-strip.test.tsx` a custom `expand` argument to
// `renderIsland` that also expands `StageRail` (this repo already has that
// pattern elsewhere — see `create-org-form.test.tsx`'s `expandRows` /
// `registration-hub-config-panel.test.tsx`'s `expandPanel`) — out of scope
// for a task that may not touch those two files.
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
