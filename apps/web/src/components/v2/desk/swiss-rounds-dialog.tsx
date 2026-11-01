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
// `addSwissRound` judges by (`addRound`, ruling C11), and at the hard maximum shown disabled with the reason.
//
// Save and Cancel sit at the end of the BODY, not in `Modal`'s `footer` slot: the body is short at every width, and
// keeping them in the children keeps the whole dialog visible to `renderIsland`'s walk (its tests drive the stepper and
// Save the way a browser would).
import { useState } from "react";
import { createPortal } from "react-dom";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { Modal } from "@/components/modal";
import { swissRefusalText } from "@/lib/swiss-refusal-text";
import { isSwissRefusalCode, swissRefusalKey } from "@/lib/swiss-refusals";
import { swissRoundsGuidanceLine, swissRoundsWarnNotice } from "@/lib/swiss-rounds";
import { swissRoundsEditPreview, type SwissRoundControl, type SwissRoundsEditFixture } from "@/lib/swiss-rounds-edit";

/** What a refused write answered (`ApiV1Error`'s code, details and English message). */
export interface SwissRoundsRefusal {
  code: string;
  extra: Record<string, unknown>;
  message: string;
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
  onClose: () => void;
}

/** What the panel hands the rail for one Swiss stage (`StageRailProps.swissRounds`). */
export interface SwissRoundsRail {
  control: SwissRoundControl;
  fixtures: readonly SwissRoundsEditFixture[];
  onSave: (stageId: string, rounds: number) => Promise<SwissRoundsRefusal | null>;
  /** `from`: the More menu's item (the panel says a refusal itself) or the dialog's recovery (the dialog says it). */
  onAddRound: (stageId: string, from: "more" | "dialog") => Promise<SwissRoundsRefusal | null>;
}

/**
 * The rail's round count. Editable (a button opening the dialog) until the stage's first start; a fixed chip after it.
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
  if (rail.control.started) {
    return (
      <span
        data-testid="stage-rounds"
        data-state="fixed"
        className="inline-flex min-h-11 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-semibold tabular-nums text-slate-600"
      >
        {label}
      </span>
    );
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
      {editing &&
        typeof document !== "undefined" &&
        createPortal(
          <SwissRoundsDialog
            stageId={stageId}
            control={rail.control}
            fixtures={rail.fixtures}
            onSave={rail.onSave}
            onAddRound={(id) => rail.onAddRound(id, "dialog")}
            onClose={() => setEditing(false)}
          />,
          document.body,
        )}
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
  if (!rail.control.started || add.refusal === "over" || add.refusal === "field") return null;
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

export function SwissRoundsDialog({ stageId, control, fixtures, onSave, onAddRound, onClose }: SwissRoundsDialogProps) {
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
  const canSave = changed && !refused && value >= preview.min && !saving;
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
  const refusalText = refusal
    ? isSwissRefusalCode(refusal.code)
      ? swissRefusalText(refusal.code, refusal.extra, msg, plural)
      : refusal.message
    : null;
  const offerAddRound = refusal?.code === "SWISS_ROUNDS_LOCKED" && refusal.extra.canAddRound === true;

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
              disabled={saving || value <= preview.min}
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
              disabled={saving || value >= preview.max}
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
        {warn && (
          <p data-testid="stage-rounds-warn" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {warn}
          </p>
        )}
        {changed && !refused && (
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
