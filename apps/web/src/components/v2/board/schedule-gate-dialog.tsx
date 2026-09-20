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
import { useMsg } from "@/components/i18n/dict-provider";
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
  fixtureTitles: fixtureTitlesProp,
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
   *  (schedule-board.tsx's `actions.board`). Absent, this dialog falls back
   *  to deriving from its own `board` prop below — byte-for-byte its prior
   *  behaviour, for a caller that has not been updated to pass it. */
  fixtureTitles?: Record<string, string>;
}) {
  const msg = useMsg();

  if (!gate) return null;
  const warning = gate.kind === "warnings";
  const title = warning
    ? msg(gate.action === "start" ? "board.gate.warnTitleStart" : "board.gate.warnTitlePublish")
    : msg("board.gate.blockTitle");

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
      <ConflictList
        conflicts={gate.conflicts}
        board={board}
        entrantNames={entrantNames}
        feedLabels={feedLabels}
        fixtureTitles={fixtureTitlesProp}
        testId="board-gate-conflict"
        ariaLabel={title}
      />
    </ConfirmDialog>
  );
}
