"use client";

// The always-on confirmation on Start tournament (design of record:
// docs/superpowers/specs/2026-09-20-start-tournament-confirmation-design.md,
// owner-approved 2026-09-20, scope amended the same day).
//
// Start is the most irreversible button in the product: it publishes the
// timetable to players and moves the division to `active`, and division status
// is forward-only (setup → scheduled → active → completed, no unpublish).
// Until this dialog existed it was one tap with no warning.
//
// IT STATES CONSEQUENCES AND NOTHING ELSE. Schedule conflicts are deliberately
// not this dialog's business: `startDivision` runs its own gate inside its own
// transaction, and the REACTIVE `board/schedule-gate-dialog.tsx` already opens
// on that refusal. A second, advisory copy of the conflict report here would
// only be able to go stale between the preview and the commit.
//
// The consequences are the verified lock table from the design, not a guess:
// start closes the entrant list (withdrawals excepted, and open formats
// exempt); it moves the PARENT competition published → live, but only from
// `published`; it does NOT itself lock the format, which locks at Generate the
// moment fixtures exist — ON THE QUICK-START PATH THAT IS THIS VERY PRESS, so
// the line has two forms and neither is omitted; and it does NOT lock match
// rules, which lock per stage as each stage's first match is scored.
import { ConfirmDialog } from "@/components/v2/confirm-dialog";
import { useMsg } from "@/components/i18n/dict-provider";

export function StartConfirmDialog({
  open,
  /** Does starting close the entrant list? FALSE for a division with any
   *  open-format stage — `lib/open-entry-stages.ts` mirrors the server's own
   *  exemption. The line is omitted entirely rather than softened, because for
   *  those divisions it is simply untrue, and a dialog that lies once is not
   *  read again. */
  entrantsLock,
  /** Does starting also move the PARENT competition published → live? TRUE
   *  only for a competition that is currently `published` —
   *  `lib/start-promotes-competition.ts` mirrors the server's own `where`.
   *  Omitted, never softened, for the same reason as the entrants line: for a
   *  draft or an already-live competition it is simply untrue. */
  competitionPromotes,
  /** Is the format ALREADY locked — i.e. do fixtures exist yet?
   *  `lib/format-already-locked.ts` mirrors `replaceStages`'s own guard. This
   *  one is NOT omitted when false, it is REPLACED: on the quick-start path
   *  `/start` is what generates the fixtures, so the format locks a moment
   *  later rather than not at all, and the organiser is owed that either way.
   *  Saying "already locked — fixtures exist" over a page reading "No fixtures
   *  yet" was a live defect found by driving the product on 2026-09-20. */
  formatLocked,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  entrantsLock: boolean;
  competitionPromotes: boolean;
  formatLocked: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const msg = useMsg();
  if (!open) return null;

  return (
    <ConfirmDialog
      open
      testId="start-confirm"
      title={msg("launch.confirm.title")}
      confirmLabel={msg("launch.start")}
      // Irreversible, but not destructive — it is the action the organiser came
      // to take, so it renders as the primary affordance, not a red one.
      confirmVariant="primary"
      cancelLabel={msg("board.cancel")}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>{msg("launch.confirm.lead")}</p>
      <ul className="list-disc space-y-1 pl-5" data-testid="start-confirm-consequences">
        {entrantsLock && (
          <li data-testid="start-confirm-entrants">{msg("launch.confirm.entrants")}</li>
        )}
        {/* Grouped with the entrants line because both are things that CHANGE;
            the two below are clarifications about what does not lock. The
            sentence states the status move and stops there — published and
            live are both in PUBLIC_DASHBOARD_STATUSES and
            `public_competitions_v` does not read status at all, so "now
            visible to players" would be false. */}
        {competitionPromotes && (
          <li data-testid="start-confirm-competition">{msg("launch.confirm.competition")}</li>
        )}
        <li data-testid={formatLocked ? "start-confirm-format-locked" : "start-confirm-format-locks"}>
          {msg(formatLocked ? "launch.confirm.format" : "launch.confirm.formatLocksNow")}
        </li>
        <li>{msg("launch.confirm.rules")}</li>
      </ul>
    </ConfirmDialog>
  );
}
