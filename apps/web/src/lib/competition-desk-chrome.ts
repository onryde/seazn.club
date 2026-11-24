// The competition page's header and divisions list, as ONE rule the async server component reads (it is not reachable from a
// unit test itself). Owner, Option 1: once the competition is FINISHED its page is a record, not a control room - finished
// divisions are listed, the tools that run a live event (Registration, the Multi Schedule Board) go, and "Add division" steps
// back from the primary button to a quiet link. Independently of phase, a COMPLETED or ARCHIVED competition cannot take a new
// division at all (the write answers 409 COMPETITION_ENDED), so it is not offered.

import { competitionIsEnded } from "@/lib/entitlements";

export interface DeskChromeInput {
  /** `competitionPhase(desk).kind`; null when the desk summary failed to load (then nothing is known to be finished). */
  phaseKind: string | null;
  /** `competitions.status` (draft | published | live | completed | archived). */
  status: string;
  canEdit: boolean;
  frozen: boolean;
}

export interface DeskChrome {
  /** The derived phase is `finished`. A competition with no divisions is `setting_up`, so never this - the empty case. */
  finished: boolean;
  showRegistration: boolean;
  showScheduleBoard: boolean;
  /** "primary": the filled button; "quiet": a text link; "none": not offered (view-only, frozen, or the competition is over). */
  addDivision: "primary" | "quiet" | "none";
  /** The ledger lists finished divisions with no "Show finished" switch. */
  ledgerListsFinished: boolean;
}

export function deskChrome({ phaseKind, status, canEdit, frozen }: DeskChromeInput): DeskChrome {
  const finished = phaseKind === "finished";
  const mayAdd = canEdit && !frozen && !competitionIsEnded(status);
  return {
    finished,
    showRegistration: !finished,
    showScheduleBoard: !finished,
    addDivision: !mayAdd ? "none" : finished ? "quiet" : "primary",
    ledgerListsFinished: finished,
  };
}
