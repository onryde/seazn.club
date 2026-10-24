import "server-only";
// What deleting an account does to the chess invites queued for its address (privacy follow-up to the sign-in half, which the
// DELETE /api/users/me route does itself: those rows are the account's and are simply deleted).
//
// A `chess_invite` row's recipient is the ACCOUNT's address, copied from `users.email` when the open queued the invite
// (guard.ts loadSide -> invite.ts queueFixtureInvite), and the row stays for the 90-day retention (RETENTION_DAYS). The row itself belongs
// to an organiser's board and outlives the player's account, so it is not deleted: the address is taken out of it.
//
//   - `queued` (never sent, or waiting on a retry): nothing may be mailed to a deleted person, so the row ends `expired`, unsent, with the
//     body gone (V470 insists on both) and `last_error = account_deleted`. It is a badly-ended row like any other, so the caller hands it
//     to the kind's hook (`afterEndedBadly`): the chess hook releases the seat's stamp if no other email for it can still arrive.
//   - every other status: the status is left exactly as it is and only the recipient is replaced.
//       `sent` / `delayed`: the provider's later events find a row by its provider id (or the outbox tag), never by recipient
//         (provider-events.ts findRow), so they still land.
//       `sending`: left to finish. Its attempt carries the address in memory from the claim and only ever writes status columns, so it
//         completes as it would have. NOT hooked: the address is gone from the row at once instead of "when it lands". The residual, accepted
//         and parked: an attempt that fails and retries re-claims the row with the placeholder, which cannot be delivered (a reserved TLD),
//         and the row ends `dead`/`bounced`, releasing the seat through the usual hook. Nothing reaches the deleted person either way.
//       terminal rows: the address is simply replaced.
//
// The match is the address EXACTLY as the account stores it (`recipient = email`, no case folding). `users.email` is unique but
// case-sensitive, so `Ann@x.io` and `ann@x.io` are two live accounts, and a folded match would reach the other one's rows (N-B).
//
// Runs on the caller's PRIVILEGED transaction (the route's `sql.begin`): `app_user` holds INSERT only on `email_outbox` (V470), so a tenant
// transaction would be refused. It must run in the SAME transaction as the account's anonymisation, so the address is never left behind an
// anonymised account (a failure here fails the deletion, which the person can retry).
import type { Tx } from "@/lib/db";
import type { EndedRow } from "./hooks";

/** Why a queued invite was ended: the row's `last_error`, a closed reason and never free text. */
export const ACCOUNT_DELETED_REASON = "account_deleted";

type EndedRecord = { id: string; ref_type: string; ref_id: string; meta: Record<string, string> };

/**
 * Take `email` out of every `chess_invite` row of the outbox, replacing it with `placeholder`, and end the ones that were still waiting
 * to be sent. Returns the rows it ended, for the caller to hand to `afterEndedBadly` AFTER the transaction commits.
 *
 * Two statements, in this order: the queued rows are ended first (they still hold the address, which the second statement then replaces
 * like every other row's), then every row holding the address, whatever its status, gets the placeholder.
 */
export async function anonymiseChessInvites(tx: Tx, a: { email: string; placeholder: string }): Promise<EndedRow[]> {
  const ended = await tx<EndedRecord[]>`
    update email_outbox
       set status = 'expired', body_sealed = null, lease_until = null, last_error = ${ACCOUNT_DELETED_REASON},
           status_at = now()
     where kind = 'chess_invite' and recipient = ${a.email} and status = 'queued'
    returning id, ref_type, ref_id, meta`;
  await tx`
    update email_outbox set recipient = ${a.placeholder}
     where kind = 'chess_invite' and recipient = ${a.email}`;
  return ended.map((r) => ({ id: r.id, kind: "chess_invite" as const, refType: r.ref_type, refId: r.ref_id, status: "expired" as const, meta: r.meta }));
}
