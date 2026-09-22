"use client";

// The organiser's way through the publish gate (#230 item 2 follow-up).
//
// `publishSchedule` and `startDivision` both refuse a board they will not put in
// front of players, with two codes that mean very different things:
//
//   SCHEDULE_UNACKNOWLEDGED_WARNINGS — "we can, but look at this first". There
//     IS a way through: re-send with `acknowledge_warnings: true`.
//   SCHEDULE_BLOCKING_CONFLICTS — physically impossible. There is NO way
//     through, by design: the flag is checked strictly after the blocking test
//     and can never reach it, and division status is forward-only
//     (setup → scheduled → active → completed) with no unpublish.
//
// So the two states are ONE dialog with a structural difference, not a shared
// dialog with a disabled button. A greyed-out "Publish anyway" says "not yet"
// and invites the organiser to hunt for the condition that ungreys it; the
// blocking case has no such condition. `ConfirmDialog` renders no confirm button
// at all when `confirmLabel` is omitted.
import { ConfirmDialog } from "@/components/v2/confirm-dialog";
import { useMsg, useLocaleOrDefault } from "@/components/i18n/dict-provider";
import type { FeedLabelPair } from "@/lib/schedule-board";
import type { BoardConflict, BoardFixture } from "./types";
import { ConflictList } from "./conflict-list";

/** Which action was refused. Only the copy differs — the contract does not. */
export type GateAction = "publish" | "start";

export interface ScheduleGate {
  /** `blocking` has no confirm affordance; `warnings` does. */
  kind: "blocking" | "warnings";
  action: GateAction;
  conflicts: BoardConflict[];
}

export function ScheduleGateDialog({
  gate,
  board,
  entrantNames,
  feedLabels,
  busy = false,
  onConfirm,
  onDismiss,
  fixtureTitles,
  divisionNames,
}: {
  /** `null` closes it. The whole dialog is driven by the last refusal. */
  gate: ScheduleGate | null;
  board: BoardFixture[];
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  busy?: boolean;
  /** Re-send the same action with `acknowledge_warnings: true`. Never called in
   *  the blocking case — there is no control that calls it. */
  onConfirm: () => void;
  onDismiss: () => void;
  /** Competition-wide fixture id -> title (`cardTitle` output), for a
   *  conflict's `details.otherFixtureId` (C3 review findings 2+3). Optional
   *  — a required prop would break every existing test constructing this
   *  dialog directly, same reasoning `FixtureBlock`'s own `fixtureTitles`
   *  prop and commit 335d750d's `entrantNames` both used. `board` here is
   *  whatever the caller passed, and schedule-board.tsx passes the
   *  DIVISION-filtered view — a cross-division counterparty is invisible to
   *  it, the same axis `FixtureBlock`'s own fix already covers. When
   *  supplied, this should be built from the UNFILTERED board
   *  (schedule-board.tsx's `actions.board`). Absent, `ConflictList` falls
   *  back to deriving from the `board` prop — byte-for-byte its prior
   *  behaviour, for a caller that has not been updated to pass it. */
  fixtureTitles?: Record<string, string>;
  /**
   * The divisions this refusal covers, on the COMPETITION-wide "Publish all"
   * (see `unreleased-banner.tsx`). One gate for the whole set, not one dialog
   * per division — but then `board.gate.warnBodyPublish` ("These warnings will
   * not stop the schedule going live…") says *the* schedule and names nothing,
   * so an organiser acknowledging warnings on three of nine divisions could not
   * tell which three they were agreeing to. The body sentence is reused
   * unchanged and this line is ADDED beneath it; it renders nothing at all on
   * the single-division path, which is byte-identical to before.
   */
  divisionNames?: string[];
}) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();

  if (!gate) return null;
  const warning = gate.kind === "warnings";
  const title = warning
    ? msg(gate.action === "start" ? "board.gate.warnTitleStart" : "board.gate.warnTitlePublish")
    : msg("board.gate.blockTitle");
  const names =
    divisionNames && divisionNames.length > 0
      ? new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(divisionNames)
      : null;

  return (
    <ConfirmDialog
      open
      testId="board-gate"
      title={title}
      // THE structural difference. Omitted, not disabled, in the blocking case.
      confirmLabel={
        warning
          ? msg(gate.action === "start" ? "board.gate.startAnyway" : "board.gate.publishAnyway")
          : undefined
      }
      cancelLabel={warning ? msg("board.cancel") : msg("board.gate.dismiss")}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onDismiss}
    >
      <p data-kind={gate.kind} data-action={gate.action}>
        {warning
          ? msg(gate.action === "start" ? "board.gate.warnBodyStart" : "board.gate.warnBodyPublish")
          : msg("board.gate.blockBody")}
      </p>
      {names !== null && (
        <p data-testid="board-gate-divisions" className="text-xs font-medium text-slate-700">
          {msg("board.publishAll.gateDivisions", { names })}
        </p>
      )}
      {/* Scrolls inside itself: a board can be refused on a dozen conflicts and
          the sheet must still fit a 375px phone without the page scrolling. */}
      <ConflictList
        conflicts={gate.conflicts}
        board={board}
        entrantNames={entrantNames}
        feedLabels={feedLabels}
        fixtureTitles={fixtureTitles}
        className="max-h-56 space-y-2 overflow-y-auto"
      />
    </ConfirmDialog>
  );
}
