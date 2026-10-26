import "server-only";
// Ending the queued chess invites of boards that are going away or have been settled (spec §7, plan T6). The ONE place that turns a
// board into its seat refs (`fixtureId:white`, `fixtureId:black`) for a cancel: the outbox core's `cancelQueuedEmails` knows no
// seats (it may not import a usecase), and every writer that clears, settles or deletes a board calls this instead of repeating the
// two-colour fan-out.
//
// Runs on the caller's `withTenant` transaction, so the cancel commits or rolls back with the write that made the invites moot: an
// Unpair that is refused (an online game stands behind a board) ends nothing. Only `queued` rows are ended (a row already `sending` is
// left to finish); a seat that was never invited has no row, and the call is then a no-op. Importing the outbox's `cancel.ts` directly,
// not its index, keeps the hook modules out of the usecases that call this.
import type { Tx } from "@/lib/db";
import { cancelQueuedEmails } from "@/server/email-outbox/cancel";
import type { EndedRow } from "@/server/email-outbox/hooks";
import { CHESS_SEAT_REF_TYPE, chessSeatRef } from "./seat-stamp";

/** The chess-invite rows of these boards, both seats, that were still queued - now ended with `reason` (one of `CANCELLED_REASONS`).
 *  Empty `fixtureIds` issues no statement. */
export function cancelBoardInvites(tx: Tx, fixtureIds: readonly string[], reason: string): Promise<EndedRow[]> {
  return cancelQueuedEmails(tx, {
    kind: "chess_invite",
    refType: CHESS_SEAT_REF_TYPE,
    refIds: fixtureIds.flatMap((id) => [chessSeatRef(id, "white"), chessSeatRef(id, "black")]),
    reason,
  });
}
