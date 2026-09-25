"use client";

// The two division launch actions (doc 12 §1, PROMPT-17):
//  A. Start tournament — quick-start: generate → sequence-slot → active.
//  B. Schedule — plan-first: opens the drag-and-drop board (generate + auto
//     pass live there); publish and start follow from the board.
import { useState } from "react";
import Link from "@/components/ui/console-link";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { routes } from "@/lib/routes";
import { PUBLISH_BLOCKED, PUBLISH_UNACKNOWLEDGED } from "@/lib/schedule-board";
import { useMsg } from "@/components/i18n/dict-provider";
import { ScheduleGateDialog } from "@/components/v2/board/schedule-gate-dialog";
import { StartConfirmDialog } from "@/components/v2/start-confirm-dialog";
import { startClosesEntrantList } from "@/lib/open-entry-stages";
import { startPromotesCompetition } from "@/lib/start-promotes-competition";
import { formatAlreadyLocked } from "@/lib/format-already-locked";
import { divisionScoringClosed } from "@/lib/division-phase";
import type { BoardConflict, BoardFixture } from "@/components/v2/board/types";

interface Props {
  divisionId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  status: string;
  canEdit: boolean;
  /** This division's fixtures and entrant names, only so the gate dialog can
   *  name the matches it is refusing. The page already holds both, so the sheet
   *  costs no extra read; `feedLabels` is NOT loaded for it — a knockout
   *  placeholder reads "TBD vs TBD" rather than "Winner of QF1", which is not
   *  worth a second query on every division page load. */
  fixtures: BoardFixture[];
  entrantNames: Record<string, string>;
  /** The `kind` of every stage in this division, and nothing else — the
   *  confirmation has to know whether starting really closes the entrant list
   *  before it says so. `enrollEntrants` exempts the WHOLE division when ANY
   *  stage is an open format, so this cannot be answered from one stage.
   *  The page already holds the stages, so it costs no extra read. */
  stageKinds: string[];
  /** The PARENT competition's status, raw. `startDivision` promotes it
   *  published → live from `published` ONLY, so the confirmation cannot say
   *  the promotion happens without knowing which status the competition is in.
   *  The page already reads the competition (COLS carries `status`), so it
   *  costs no extra query — and the derivation lives here, beside
   *  `startClosesEntrantList`, so a unit test can drive all five statuses
   *  through it. */
  competitionStatus: string;
  viewerPlan: ViewerPlan;
}

export function LaunchActions({
  divisionId,
  orgSlug,
  compSlug,
  divSlug,
  status,
  canEdit,
  fixtures,
  entrantNames,
  stageKinds,
  competitionStatus,
  viewerPlan,
}: Props) {
  const msg = useMsg();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  // Starting PUBLISHES the schedule, so it is refused the two ways publish is
  // (#230 item 2 follow-up), and this is the button the pro and community
  // journeys actually press. Without this the 422 was flattened into
  // `err.message` in a red span, `extra.conflicts` was dropped, and there was
  // no control that could send `acknowledge_warnings` — the same dead end the
  // BOARD's start button had, left behind when that one was fixed.
  const [gate, setGate] = useState<{ kind: "blocking" | "warnings"; conflicts: BoardConflict[] } | null>(
    null,
  );
  // THE always-on confirmation (design 2026-09-20). Start publishes the
  // timetable to players and moves the division to `active`, and status is
  // forward-only — so nothing here may POST until this is true. It is a
  // separate piece of state from `gate` on purpose: `gate` is the REACTIVE
  // refusal and still opens, unchanged, when the server turns a confirmed
  // start down.
  const [confirming, setConfirming] = useState(false);

  async function start(acknowledgeWarnings = false) {
    setBusy(true);
    setError(null);
    try {
      const out = await apiV1<{ generated: number }>(`/api/v1/divisions/${divisionId}/start`, {
        method: "POST",
        // No body unless the organiser is acknowledging: /start parses an absent
        // one as `{}` and every existing key client POSTs it with none, so the
        // console must not start requiring one.
        json: acknowledgeWarnings ? { acknowledge_warnings: true } : undefined,
      });
      setGate(null);
      if (out.generated > 0) {
        router.push("?tab=fixtures");
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall(String(err.extra.feature_key ?? ""));
      } else if (
        err instanceof ApiV1Error &&
        (err.code === PUBLISH_BLOCKED || err.code === PUBLISH_UNACKNOWLEDGED)
      ) {
        // Re-opened rather than closed on a second refusal: an organiser who
        // acknowledges warnings while somebody else drags a card into a court
        // clash must be told THAT, not dropped back believing it started. `kind`
        // is read off the CODE, never recomputed from the rows — the server's
        // blocking test and the rows' own `blocking` flags disagree by design.
        setGate({
          kind: err.code === PUBLISH_BLOCKED ? "blocking" : "warnings",
          conflicts: (err.extra.conflicts as BoardConflict[] | undefined) ?? [],
        });
      } else {
        setError(err instanceof Error ? err.message : msg("launch.failedStart"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canEdit && divisionScoringClosed(status) && (
        <button
          type="button"
          data-testid="launch-start-division"
          disabled={busy}
          // Opens the confirmation. It does NOT start: the POST lives on the
          // dialog's own confirm, below.
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="btn btn-primary px-3 py-1.5 text-xs"
          title={msg("launch.startTitle")}
        >
          {busy ? msg("launch.starting") : msg("launch.start")}
        </button>
      )}
      <Link href={routes.divisionSchedule(orgSlug, compSlug, divSlug)} className="btn btn-ghost px-3 py-1.5 text-xs">
        {msg("launch.schedule")}
      </Link>
      {paywall && <UpgradeGate feature={paywall} compact viewerPlan={viewerPlan} />}
      {error && <span className="text-xs text-red-600">{error}</span>}
      {/* Closed BEFORE the POST, not after it: a confirmed start that the
          server then refuses has to land in the gate dialog below, and two
          sheets open at once is not a state this surface has. */}
      <StartConfirmDialog
        open={confirming}
        entrantsLock={startClosesEntrantList(stageKinds)}
        competitionPromotes={startPromotesCompetition(competitionStatus)}
        // The page already holds this division's fixtures for the gate sheet, so
        // the predicate costs no extra read — see `fixtures` above.
        formatLocked={formatAlreadyLocked(fixtures.length)}
        busy={busy}
        onConfirm={() => {
          setConfirming(false);
          void start();
        }}
        onCancel={() => setConfirming(false)}
      />
      {/* The way through the gate — and, for a blocking board, the honest report
          that there is none. Same dialog the board's start button opens, so the
          two paths to the same endpoint refuse identically. */}
      <ScheduleGateDialog
        gate={gate ? { ...gate, action: "start" } : null}
        board={fixtures}
        entrantNames={entrantNames}
        feedLabels={{}}
        busy={busy}
        onConfirm={() => void start(true)}
        onDismiss={() => setGate(null)}
      />
    </div>
  );
}
