"use client";

// W3 Task 12 Phase 2 (SW-M10, #838, X-SW-17; owner pick B, "the edit dialog"): the stage rail's "Rounds: N · Edit"
// opens this. A round-count change deletes or mints whole rounds of matches and Undo cannot reverse it
// (SWISS_ROUNDS_CHANGE_NOT_UNDOABLE), so before anything is written the dialog says exactly what Save does — which
// unplayed rounds go or come, and how many matches — from `swissRoundsEditPreview` (lib/swiss-rounds-edit.ts), the
// server's own rules read over the same rows. Save sends `PATCH /stages/{id} { rounds }` once.
//
// The stepper keeps to what the server takes: never below the latest paired round (SWISS_ROUNDS_BELOW_SEATED), never
// above the field's hard maximum (SWISS_ROUNDS_ABOVE_MAX) — so the dialog cannot lead to either refusal. A stored count
// already above the maximum (the field shrank before Start, carry c2) opens as it is and may only go down. A refusal
// that still comes back (the stage started meanwhile: SWISS_ROUNDS_LOCKED) is said in the reader's language, and when
// its `canAddRound` says Add a round goes through, that button stands beside it.
//
// Beside it, the two rail pieces (stage-rail.tsx mounts them; this file owns their state and copy so the rail's own Swiss
// blocks stay untouched): `SwissRoundsChip`, "Rounds: N · Edit" until the stage's first start and a fixed "Rounds: N"
// after it, and `SwissAddRoundMenuItem`, the More menu's "Add a round" after that start — offered on THE predicate
// `addSwissRound` judges by (`addRound`, ruling C11), and at the hard maximum shown disabled with the reason. W3 T13 adds
// `SwissFinishMenuItem`, the More menu's "Finish the Swiss now" beside it — offered on THE Finish predicate (`finish`,
// `swissFinishState`), disabled with the reason while no round is complete or the round in progress is undecided — and
// the same Finish as the dialog's recovery when a SWISS_ROUNDS_LOCKED refusal says `canFinish: true`. Either way the
// panel confirms first ("Standings after round {k} become final…", `swissFinishConfirm`), then posts. Batch 4 (ruling 3):
// both items show on ANY running Swiss, root or fed (`swissMoreItemsOf`, the one rule) — a fed Swiss, which has no "Add
// late player", gets its own More holding just these two (`SwissMoreMenu`), so the rail's late-add block stays as it is.
//
// Save and Cancel sit at the end of the BODY, not in `Modal`'s `footer` slot: the body is short at every width, and
// keeping them in the children keeps the whole dialog visible to `renderIsland`'s walk (its tests drive the stepper and
// Save the way a browser would).
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { Modal } from "@/components/modal";
import { swissFinishPlanOf, type SwissFinishPlan } from "@/lib/swiss-finish-plan";
import { swissRefusalKey } from "@/lib/swiss-refusals";
import { swissRoundsGuidanceLine, swissRoundsWarnNotice } from "@/lib/swiss-rounds";
import { swissMoreItemsOf, swissRoundsEditPreview, type SwissRoundControl, type SwissRoundsEditFixture } from "@/lib/swiss-rounds-edit";
import {
  alignOf,
  floatsNow,
  POPOVER_RAISED,
  popoverClasses,
  pressedAnItem,
  useStagePopover,
  type PopoverAlign,
} from "./stage-popover";

/** What a refused write answered: `ApiV1Error`'s code and details, and `text`, the refusal in the reader's language as
 *  the panel says it (`swissStageRefusal`) — never the server's English sentence (T12 Fix round 1, review m1). */
export interface SwissRoundsRefusal {
  code: string;
  extra: Record<string, unknown>;
  text: string;
}

export interface SwissRoundsDialogProps {
  stageId: string;
  control: SwissRoundControl;
  /** The stage's own rows (the preview reads which rounds hold shells and which hold a seat). */
  fixtures: readonly SwissRoundsEditFixture[];
  /** Saves the count; resolves null when it landed (the panel has said so and refreshed), else the refusal. */
  onSave: (stageId: string, rounds: number) => Promise<SwissRoundsRefusal | null>;
  /** "Add a round", the recovery a SWISS_ROUNDS_LOCKED refusal offers; same answer shape. */
  onAddRound: (stageId: string) => Promise<SwissRoundsRefusal | null>;
  /** W3 T13: "Finish the Swiss now", the other recovery it offers (`canFinish`). The dialog closes first; the panel
   *  confirms and says the answer itself. */
  onFinish: (stageId: string, plan: SwissFinishPlan) => void;
  onClose: () => void;
}

/** What the panel hands the rail for one Swiss stage (`StageRailProps.swissRounds`). */
export interface SwissRoundsRail {
  control: SwissRoundControl;
  fixtures: readonly SwissRoundsEditFixture[];
  onSave: (stageId: string, rounds: number) => Promise<SwissRoundsRefusal | null>;
  /** `from`: the More menu's item (the panel says a refusal itself) or the dialog's recovery (the dialog says it). */
  onAddRound: (stageId: string, from: "more" | "dialog") => Promise<SwissRoundsRefusal | null>;
  /** W3 T13: "Finish the Swiss now" after round `plan.after` — confirmed by the panel, then posted; the panel says the
   *  answer (resolves null when it landed, else the refusal). */
  onFinish: (stageId: string, plan: SwissFinishPlan) => Promise<SwissRoundsRefusal | null>;
}

/**
 * The rail's round count. Editable (a button opening the dialog) until the stage's first start; nothing in the row after it (the legend
 * line says "N rounds"; SCF).
 * The dialog is portalled to <body>: the phone sheet it opens from is itself a modal layer with a focus trap, and
 * `onOpen` lets the rail close that sheet first.
 */
export function SwissRoundsChip({
  stageId,
  busy,
  rail,
  onOpen,
}: {
  stageId: string;
  busy: string | null;
  rail: SwissRoundsRail;
  onOpen: () => void;
}) {
  const msg = useMsg();
  const [editing, setEditing] = useState(false);
  const label = msg("stage.rounds.chip", { n: rail.control.rounds });
  const dialog =
    editing &&
    typeof document !== "undefined" &&
    createPortal(
      <SwissRoundsDialog
        stageId={stageId}
        control={rail.control}
        fixtures={rail.fixtures}
        onSave={rail.onSave}
        onAddRound={(id) => rail.onAddRound(id, "dialog")}
        onFinish={(id, plan) => void rail.onFinish(id, plan)}
        onClose={() => setEditing(false)}
      />,
      document.body,
    );
  if (rail.control.started) {
    // The count is fixed once the stage has started (SW-M10, X-SW-17): there is nothing to press, and the legend line already says
    // "N rounds", so nothing is drawn in the action row (SCF, owner pick Option A - a bordered pill that does nothing reads as a
    // button). Only a dialog that was open when the stage started stays, over nothing: the desk refreshes under it (a LOCKED answer),
    // and its refusal and its Add a round recovery must not be swept away by that refresh (T12 Fix round 1, review m4).
    return <>{dialog}</>;
  }
  return (
    <>
      <button
        type="button"
        data-testid="stage-rounds"
        data-state="editable"
        aria-haspopup="dialog"
        disabled={busy !== null}
        onClick={() => {
          onOpen();
          setEditing(true);
        }}
        className="btn btn-ghost min-h-11 justify-between gap-3 px-3 py-1.5 text-xs"
      >
        <span className="font-semibold tabular-nums text-slate-800">{label}</span>
        <span className="border-l border-purple-200 pl-3">{msg("stage.rounds.edit")}</span>
      </button>
      {dialog}
    </>
  );
}

/**
 * "Add a round" in the rail's More menu (X-SW-17, ruling 250): after the stage's first start, the one way to grow the
 * Swiss (before it, the dialog edits the count). Nothing when the Swiss is over or has no pairable field; disabled with
 * the reason at the field's hard maximum.
 */
export function SwissAddRoundMenuItem({ stageId, busy, rail }: { stageId: string; busy: string | null; rail: SwissRoundsRail }) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const add = rail.control.addRound;
  if (!swissMoreItemsOf(rail.control).addRound) return null;
  return (
    <button
      type="button"
      data-testid="stage-add-round"
      disabled={busy !== null || !add.canAddRound}
      onClick={() => void rail.onAddRound(stageId, "more")}
      className="flex min-h-11 flex-col items-start justify-center border-b border-purple-100 px-4 py-2 text-left last:border-b-0 hover:bg-purple-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      <span className={`text-sm font-medium ${add.canAddRound ? "text-purple-700" : "text-slate-400"}`}>{msg("stage.more.addRound")}</span>
      {/* A started Swiss always has its field (a fed one is drawn before it can start); with none there is no count to say. */}
      {add.field !== null && (
        <span className="text-xs text-slate-500" data-testid="stage-add-round-hint">
          {add.canAddRound
            ? plural("stage.more.addRound.hint", add.field, { round: rail.control.rounds + 1 })
            : plural("stage.more.addRound.atMax", add.hardMax ?? 0, { field: add.field })}
        </span>
      )}
    </button>
  );
}

/**
 * "Finish the Swiss now" in the rail's More menu (W3 T13, RB3-20, X-SW-26): after the stage's first start, end the Swiss
 * after its last complete round. Offered on THE Finish predicate (`control.finish`, the one `finishSwissNow` judges by);
 * nothing once the Swiss is over; disabled with the reason before any round is complete, or while the round in progress
 * is under way. `onOpen` closes the phone sheet first: the confirm is a modal of its own.
 */
export function SwissFinishMenuItem({
  stageId,
  busy,
  rail,
  onOpen,
}: {
  stageId: string;
  busy: string | null;
  rail: SwissRoundsRail;
  onOpen: () => void;
}) {
  const msg = useMsg();
  const finish = rail.control.finish;
  // Nothing once the Swiss is over, nor when every round is decided — Complete is the action then (batch-4 ruling m3).
  if (!swissMoreItemsOf(rail.control).finish) return null;
  const hint = finish.canFinish
    ? msg("stage.more.finishSwiss.hint", { round: finish.finishedAfter })
    : msg(
        finish.refusal === "nothing_played"
          ? "stage.more.finishSwiss.nothingPlayed"
          : finish.inProgress
            ? "stage.more.finishSwiss.undecided"
            : "stage.more.finishSwiss.reopened",
      );
  return (
    <button
      type="button"
      data-testid="stage-finish-swiss"
      disabled={busy !== null || !finish.canFinish}
      onClick={() => {
        onOpen();
        void rail.onFinish(stageId, { after: finish.finishedAfter, rounds: rail.control.rounds });
      }}
      className="flex min-h-11 flex-col items-start justify-center border-b border-purple-100 px-4 py-2 text-left last:border-b-0 hover:bg-purple-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      <span className={`text-sm font-medium ${finish.canFinish ? "text-purple-700" : "text-slate-400"}`}>{msg("stage.more.finishSwiss")}</span>
      <span className="text-xs text-slate-500" data-testid="stage-finish-swiss-hint">
        {hint}
      </span>
    </button>
  );
}

/**
 * The rail's More for a running Swiss that has no "Add late player" — a fed Swiss (batch-4 ruling 3: Add a round and
 * Finish the Swiss now are offered on ANY running Swiss; only the late add is root-only). The same toggle, panel, testids and
 * floating behaviour (SCF, stage-popover.ts) as the late-add More in stage-rail.tsx, which keeps its own block; the rail mounts
 * exactly one of the two. Nothing at all when neither item shows (`swissMoreItemsOf`), so the toggle never opens an empty panel. The open
 * state is the rail's (`open`/`onToggle`); `onFinishOpen` closes the phone sheet before Finish's confirm.
 */
export function SwissMoreMenu({
  stageId,
  busy,
  rail,
  open,
  onToggle,
  onFinishOpen,
}: {
  stageId: string;
  busy: string | null;
  rail: SwissRoundsRail;
  open: boolean;
  onToggle: () => void;
  onFinishOpen: () => void;
}) {
  const msg = useMsg();
  const items = swissMoreItemsOf(rail.control);
  // SCF: the same floating menu as the rail's late-add More (stage-popover.ts) - this one's open state is the rail's (`open` /
  // `onToggle`), so closing it is a toggle, and `onToggle` is only ever asked while `open` (the hook fires only then).
  const [align, setAlign] = useState<PopoverAlign>("start");
  const toggleRef = useRef<HTMLButtonElement>(null);
  const rootRef = useStagePopover(open, (how) => {
    onToggle();
    if (how === "escape") toggleRef.current?.focus();
  });
  if (!items.addRound && !items.finish) return null;
  return (
    <div ref={rootRef} data-testid="stage-more-root" className="flex min-w-0 flex-col gap-2 md:relative">
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls={`stage-more-menu-${stageId}`}
        onClick={() => {
          if (!open) setAlign(alignOf(rootRef.current));
          onToggle();
        }}
        data-testid="stage-more"
        className="btn btn-ghost min-h-11 justify-between gap-1.5 px-3 py-1.5 text-xs"
      >
        {msg("desk.tools.more")}
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      <div
        id={`stage-more-menu-${stageId}`}
        hidden={!open}
        data-testid="stage-more-menu"
        onClick={(e) => {
          if (!floatsNow() || !pressedAnItem(e.target)) return;
          onToggle();
          toggleRef.current?.focus();
        }}
        className={popoverClasses(align)}
      >
        <div className={`flex flex-col overflow-hidden rounded-xl border border-purple-200 bg-white ${POPOVER_RAISED}`}>
          <SwissAddRoundMenuItem stageId={stageId} busy={busy} rail={rail} />
          <SwissFinishMenuItem stageId={stageId} busy={busy} rail={rail} onOpen={onFinishOpen} />
        </div>
      </div>
    </div>
  );
}

export function SwissRoundsDialog({ stageId, control, fixtures, onSave, onAddRound, onFinish, onClose }: SwissRoundsDialogProps) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const from = control.rounds;
  const [value, setValue] = useState(from);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<SwissRoundsRefusal | null>(null);

  const preview = swissRoundsEditPreview({ fixtures, from, to: value, control });
  const changed = value !== from;
  const refused = preview.judgement?.verdict === "refuse";
  const guidance = control.field === null ? null : swissRoundsGuidanceLine(control.field, plural);
  const warn = preview.judgement ? swissRoundsWarnNotice(preview.judgement, plural) : null;
  // T12 Fix round 1 (review m4): once the server says the count is fixed (or the refreshed read does), nothing here can
  // change it — the stepper and Save go inactive and the preview of a change that will not happen goes.
  const locked = control.started || refusal?.code === "SWISS_ROUNDS_LOCKED";
  const canSave = changed && !refused && !locked && value >= preview.min && !saving;
  const labelId = `stage-rounds-label-${stageId}`;

  const run = async (write: () => Promise<SwissRoundsRefusal | null>) => {
    setSaving(true);
    setRefusal(null);
    const answer = await write();
    setSaving(false);
    if (answer === null) onClose();
    else setRefusal(answer);
  };

  const removedLine = preview.removed
    ? preview.removed.from === preview.removed.to
      ? plural("stage.rounds.preview.removeOne", preview.removed.matches, { round: preview.removed.from })
      : plural("stage.rounds.preview.removeMany", preview.removed.matches, { from: preview.removed.from, to: preview.removed.to })
    : null;
  const addedLine = preview.added
    ? preview.added.from === preview.added.to
      ? plural("stage.rounds.preview.addOne", preview.added.matchesPerRound, { round: preview.added.from })
      : plural("stage.rounds.preview.addMany", preview.added.matchesPerRound, { from: preview.added.from, to: preview.added.to })
    : null;
  const refusalText = refusal?.text ?? null;
  const offerAddRound = refusal?.code === "SWISS_ROUNDS_LOCKED" && refusal.extra.canAddRound === true;
  // W3 T13: the refusal's `canFinish` is THE Finish predicate's answer, and its plan rides with it — on ANY refusal that
  // carries one (batch-4 m5): the LOCKED's Add a round can come back SWISS_ROUNDS_ABOVE_MAX 409 `canFinish: true` when the
  // field shrank meanwhile, and its sentence then names Finish.
  const finishPlan = refusal ? swissFinishPlanOf(refusal.extra) : null;

  const stepClass =
    "grid h-11 w-11 place-items-center text-xl leading-none text-purple-700 hover:bg-purple-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent";

  return (
    <Modal title={msg("stage.rounds.dialog.title")} onClose={onClose}>
      <div data-testid="stage-rounds-dialog" className="space-y-4">
        <p>{msg("stage.rounds.dialog.intro")}</p>
        <div className="flex items-center justify-between gap-3">
          <span id={labelId} className="text-sm font-semibold text-slate-800">
            {msg("stage.rounds.dialog.label")}
          </span>
          <div
            role="group"
            aria-labelledby={labelId}
            className="inline-flex shrink-0 items-stretch overflow-hidden rounded-lg border border-purple-200 bg-white"
          >
            <button
              type="button"
              aria-label={msg("stage.rounds.dialog.fewer")}
              data-testid="stage-rounds-fewer"
              disabled={saving || locked || value <= preview.min}
              onClick={() => setValue((v) => v - 1)}
              className={stepClass}
            >
              <span aria-hidden="true">−</span>
            </button>
            <output
              aria-live="polite"
              data-testid="stage-rounds-value"
              className="grid h-11 min-w-12 place-items-center border-x border-purple-100 px-2 text-lg font-semibold tabular-nums text-slate-900"
            >
              {value}
            </output>
            <button
              type="button"
              aria-label={msg("stage.rounds.dialog.more")}
              data-testid="stage-rounds-more"
              disabled={saving || locked || value >= preview.max}
              onClick={() => setValue((v) => v + 1)}
              className={stepClass}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
        </div>
        {(guidance || (value === preview.min && preview.min > 1)) && (
          <div className="space-y-1 text-xs leading-snug text-slate-500">
            {guidance && <p data-testid="stage-rounds-guidance">{guidance}</p>}
            {value === preview.min && preview.min > 1 && (
              <p data-testid="stage-rounds-min">{msg(swissRefusalKey("SWISS_ROUNDS_BELOW_SEATED"))}</p>
            )}
          </div>
        )}
        {refused && (
          <p data-testid="stage-rounds-above-max" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {msg(swissRefusalKey("SWISS_ROUNDS_ABOVE_MAX"))}
          </p>
        )}
        {warn && !locked && (
          <p data-testid="stage-rounds-warn" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {warn}
          </p>
        )}
        {changed && !refused && !locked && (
          <div
            data-testid="stage-rounds-preview"
            className="space-y-1 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-sm text-slate-800"
          >
            {removedLine && <p data-testid="stage-rounds-removed">{removedLine}</p>}
            {addedLine && <p data-testid="stage-rounds-added">{addedLine}</p>}
            {!preview.drawn && <p data-testid="stage-rounds-not-drawn">{msg("stage.rounds.preview.notDrawn")}</p>}
            <p className="text-xs text-slate-600">{msg(swissRefusalKey("SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"))}</p>
          </div>
        )}
        {refusalText && (
          <div role="alert" data-testid="stage-rounds-error" className="space-y-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            <p>{refusalText}</p>
            {(finishPlan || offerAddRound) && (
              <div className="flex flex-wrap gap-2">
                {finishPlan && (
                  <button
                    type="button"
                    data-testid="stage-rounds-finish"
                    disabled={saving}
                    onClick={() => {
                      onClose();
                      onFinish(stageId, finishPlan);
                    }}
                    className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs"
                  >
                    {msg("stage.more.finishSwiss")}
                  </button>
                )}
                {offerAddRound && (
                  <button
                    type="button"
                    data-testid="stage-rounds-add-round"
                    disabled={saving}
                    onClick={() => void run(() => onAddRound(stageId))}
                    className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs"
                  >
                    {msg("stage.more.addRound")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} data-testid="stage-rounds-cancel" className="btn btn-ghost min-h-11 px-4 text-sm">
            {msg("schedule.cancel")}
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void run(() => onSave(stageId, value))}
            data-testid="stage-rounds-save"
            className="btn btn-primary min-h-11 px-4 text-sm"
          >
            {saving ? msg("schedule.working") : msg("stage.rounds.dialog.save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
