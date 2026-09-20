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
import type { MessageKey } from "@/lib/messages";
import type { FeedLabelPair } from "@/lib/schedule-board";
import {
  CONFLICT_HELP,
  CONFLICT_LABEL,
  cardTitle,
  type BoardConflict,
  type BoardConflictDetail,
  type BoardFixture,
} from "./types";
import { formatBoardConflictDetail } from "./conflict-detail-format";

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
  // The same two lookups the conflicts panel uses, so a code reads identically
  // whether the organiser met it in the panel or in this refusal.
  const label = (code: string) => {
    const key = `board.conflict.${code}` as MessageKey;
    const out = msg(key);
    return out === key ? (CONFLICT_LABEL[code] ?? code) : out;
  };
  // Same fallback order as the conflicts panel: the generic code-level help
  // wins when the locale has it, otherwise this conflict's own structured
  // `details` (localized, name-resolved — never the deprecated raw `detail`
  // string, C3 2026-08-13 design amendment). NOT dead in production: this
  // branch is what an organiser sees for any code with neither a
  // `board.conflictHelp.<code>` key in any of the four dictionaries nor a
  // `CONFLICT_HELP` entry (`types.ts`). `conflict.start_window`
  // (`lib/schedule-board.ts:39`) used to be exactly that case; it gained
  // both (P95 windows pass) and now resolves through the locale key above
  // instead. Kept for every other unmapped future code.
  const help = (code: string, details?: BoardConflictDetail) => {
    const key = `board.conflictHelp.${code}` as MessageKey;
    const out = msg(key);
    if (out !== key) return out;
    if (CONFLICT_HELP[code]) return CONFLICT_HELP[code];
    return details ? formatBoardConflictDetail(details, { msg, entrantNames, fixtureTitles }) : "";
  };

  if (!gate) return null;
  const warning = gate.kind === "warnings";
  const byId = new Map(board.map((f) => [f.id, f]));
  // Competition-wide fixture id -> title, for a conflict's
  // `details.otherFixtureId`. NOT safely derivable from `board` alone (a
  // prior comment here claimed it was): schedule-board.tsx passes this
  // dialog the division-filtered `board`, so a cross-division counterparty
  // is invisible to a map built from it (C3 review findings 2+3). Prefer
  // the caller-supplied, board-wide map; fall back to the filtered
  // self-derivation only when no caller has been updated to pass one.
  const fixtureTitles =
    fixtureTitlesProp ?? Object.fromEntries(board.map((f) => [f.id, cardTitle(f, entrantNames, feedLabels)]));
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
      {/* Scrolls inside itself: a board can be refused on a dozen conflicts and
          the sheet must still fit a 375px phone without the page scrolling. */}
      <ul className="max-h-56 space-y-2 overflow-y-auto">
        {gate.conflicts.map((c, i) => {
          const f = byId.get(c.fixture_id);
          return (
            <li
              key={`${c.fixture_id}-${c.code}-${i}`}
              data-testid="board-gate-conflict"
              data-code={c.code}
              data-blocking={c.blocking ? "yes" : "no"}
              className={`rounded-lg border p-2 text-xs ${
                c.blocking ? "border-red-200 bg-red-50/60" : "border-amber-200 bg-amber-50/60"
              }`}
            >
              <p className="font-medium text-slate-800">
                {/* Fix round 3 (Important 3): `lookup` was left off — an
                    unfilled slot's label fell through to cardTitle's
                    client-safe English default instead of `msg` (useMsg(),
                    line 62), regardless of this org's locale. */}
                {f
                  ? cardTitle(f, entrantNames, feedLabels, msg)
                  : msg("board.conflicts.removedFixture")}
              </p>
              <p className="mt-0.5 text-slate-600">
                <span
                  className={`mr-1 rounded px-1 font-semibold ${
                    c.blocking ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {label(c.code)}
                </span>
                {help(c.code, c.details)}
              </p>
            </li>
          );
        })}
      </ul>
    </ConfirmDialog>
  );
}
