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
import Link from "@/components/ui/console-link";
import { ConfirmDialog } from "@/components/v2/confirm-dialog";
import { useMsg } from "@/components/i18n/dict-provider";
import type { StartEntrantsLine } from "@/lib/open-entry-stages";

export function StartConfirmDialog({
  open,
  /** What starting does to the entrant list (`startEntrantsLine`,
   *  `lib/open-entry-stages.ts`, which mirrors the server's own exemption):
   *  `"closes"`; `"swiss_late"` — a running root Swiss still takes late
   *  entrants (W3 T9), so the closing line would be false and is REPLACED by
   *  what stays open; or `null` for an open-format division, where the line is
   *  omitted entirely rather than softened, because for those divisions it is
   *  simply untrue, and a dialog that lies once is not read again. */
  entrantsLine,
  /** Does starting also move the PARENT competition published → live? TRUE
   *  only for a competition that is currently `published` —
   *  `lib/start-promotes-competition.ts` mirrors the server's own `where`.
   *  Omitted, never softened, for the same reason as the entrants line: for a
   *  draft or an already-live competition it is simply untrue. */
  competitionPromotes,
  /** Do fixtures exist yet? The format no longer locks with them (FMT5: it locks at the first result that stands). Before
   *  Start no result can be recorded, so the format is still open whenever this dialog shows - held by two named
   *  refusals, not by this comment: live scoring's phase gate (scoring.ts, `divisionScoringClosed` → WRONG_PHASE
   *  "division has not started — scoring is closed") and the import's (event-import.ts, `import.division_not_started`).
   *  The Division rules card reads the lock itself (`divisionFormatLocked`); this dialog does not. On the quick-start path `/start` is what
   *  generates the fixtures, so the line says that too; it is REPLACED, never omitted, because the organiser is owed the
   *  format's state either way. Saying "fixtures exist" over a page reading "No fixtures yet" was a live defect found by
   *  driving the product on 2026-09-20. */
  fixturesExist,
  /** Is the parent competition a PUBLIC DRAFT — unlisted now, listed the
   *  moment it is published (`publishWouldList`)? Owner decision 2026-09-27: a
   *  draft is unlisted until published, and Start never publishes it (the
   *  promotion above is published → live only), so an organiser starting a
   *  tournament is told here that nobody browsing can find it yet. Not a
   *  consequence of Start, so it sits below the list, not in it. False for a
   *  private or unlisted draft — "until you publish" would be untrue there. */
  unlistedDraft,
  /** Where the competition is published: its settings page. */
  settingsHref,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  entrantsLine: StartEntrantsLine;
  competitionPromotes: boolean;
  fixturesExist: boolean;
  unlistedDraft: boolean;
  settingsHref: string;
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
        {entrantsLine === "closes" && (
          <li data-testid="start-confirm-entrants">{msg("launch.confirm.entrants")}</li>
        )}
        {entrantsLine === "swiss_late" && (
          <li data-testid="start-confirm-entrants-swiss">{msg("launch.confirm.entrantsSwiss")}</li>
        )}
        {/* W4 T9 (X-LE-1): a root knockout takes a late player into round 1 while a slot is free. */}
        {entrantsLine === "knockout_late" && (
          <li data-testid="start-confirm-entrants-knockout">{msg("launch.confirm.entrantsKnockout")}</li>
        )}
        {/* Grouped with the entrants line because both are things that CHANGE;
            the two below are clarifications about what does not lock. The
            sentence states the status move and stops there — published and
            live are both in PUBLIC_DASHBOARD_STATUSES, and every listing
            surface (org home, sitemap, `public_competitions_v`) excludes only
            DRAFTS (V419), treating published and live alike — so "now
            visible to players" would be false. */}
        {competitionPromotes && (
          <li data-testid="start-confirm-competition">{msg("launch.confirm.competition")}</li>
        )}
        <li data-testid={fixturesExist ? "start-confirm-format-open" : "start-confirm-format-generates"}>
          {msg(fixturesExist ? "launch.confirm.formatOpen" : "launch.confirm.formatGenerates")}
        </li>
        <li>{msg("launch.confirm.rules")}</li>
      </ul>
      {unlistedDraft && (
        <p
          data-testid="start-confirm-draft"
          className="rounded-md bg-amber-50 px-2.5 py-1.5 text-xs leading-relaxed text-amber-900"
        >
          {msg("launch.confirm.draft")}{" "}
          <Link href={settingsHref} className="font-medium underline underline-offset-2">
            {msg("launch.confirm.draftLink")}
          </Link>
        </p>
      )}
    </ConfirmDialog>
  );
}
