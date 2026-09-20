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
// The three consequences are the verified lock table from the design, not a
// guess: start closes the entrant list (withdrawals excepted, and open formats
// exempt); it does NOT lock the format, which locked at Generate the moment
// fixtures existed; and it does NOT lock match rules, which lock per stage as
// each stage's first match is scored.
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
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  entrantsLock: boolean;
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
        <li>{msg("launch.confirm.format")}</li>
        <li>{msg("launch.confirm.rules")}</li>
      </ul>
    </ConfirmDialog>
  );
}
