import "server-only";
// What deleting an account does to the email outbox (phase 3 spec D5: it ends and scrubs only the ACCOUNT'S OWN rows). Called by
// DELETE /api/users/me, on its privileged transaction, in this order:
//   1. the account's sign-in links (`magic_link`) are DELETED, by the account's ref and by its exact address (unchanged since the
//      sign-in half of this follow-up shipped);
//   2. the account's rows still `queued` END: `expired`, unsent, body and lease gone (V470 insists on both), `last_error =
//      account_deleted`. They are badly-ended rows like any other, so they are returned for the caller to hand to the kind's hook
//      (`afterEndedBadly`) once the transaction commits: the chess hook releases the seat's stamp if no other email for it can still
//      arrive;
//   3. EVERY one of the account's rows, whatever its status, has its recipient replaced by the placeholder, so the address does not
//      outlive the account in a table that keeps a row for the 90-day retention.
//
// WHICH ROWS ARE THE ACCOUNT'S:
//   - `recipient_user_id = <the account>`, at whatever address the row was queued to (F3: the account may have changed its address since,
//     and the row still belongs to it). Written by every account kind since V472.
//   - a `chess_invite` queued BEFORE V472, which carries no user id: it is addressed to the account's address EXACTLY as `users.email`
//     stores it (FU2). `users.email` is unique but case-sensitive, so `Ann@x.io` and `ann@x.io` are two live accounts and a folded
//     match would reach the other one's rows (N-B). A row that does name an account is that account's, never this one's, even when it
//     holds this address (a previous owner of it): hence `recipient_user_id is null`.
//   - NOT a row of a literal-address kind (`registration_confirmation` ...) queued to the account's address. It is the organiser's:
//     an entry, a payment or a refund they keep their record of (D5). A kind is the account's only if it names the account.
//
// WHAT THE STATUS DOES (steps 2 and 3; the row keeps its status when it is not queued):
//   - `sent` / `delayed`: the provider's later events find a row by its provider id (or the outbox tag), never by recipient
//     (provider-events.ts findRow), so they still land.
//   - `sending`: left to finish. Its attempt carries the address in memory from the claim and only ever writes status columns, so it
//     completes as it would have. NOT hooked: the address is gone from the row at once instead of "when it lands". If its attempt
//     fails and retries, the re-claim finds the account gone and ends the row (recipient.ts `deleted`); a pre-V472 row, which names no
//     account, is re-claimed with the placeholder, which cannot be delivered (a reserved TLD) and ends it `dead`/`bounced`, releasing
//     the seat through the usual hook. Nothing reaches the deleted person either way.
//   - terminal rows: the address is simply replaced.
//
// EACH OF STEPS 2 AND 3 IS TWO STATEMENTS, NOT ONE `or`. The two arms of "the account's rows" have different access paths, and one
// statement with `a or b` takes the worse of them for both (EXPLAIN on 105k rows: a Seq Scan on the whole table). Split:
//   - the account arm (every row since V472, the arm that grows) is a Bitmap Index Scan on `email_outbox_recipient_user_idx`, in the end
//     and in the scrub alike;
//   - the legacy arm's END is an Index Scan on `email_outbox_due_idx` (it also carries `status = 'queued'`, which that partial index serves);
//   - the legacy arm's SCRUB (all statuses) is still a Seq Scan: no index leads on `recipient`, and there is none for it to fall back to
//     even with sequential scans disabled. It is the arm that only drains (V472 stopped writing such rows, retention removes them within
//     90 days), runs once per deleted account, and is no worse than the `chess_invite` scrub it replaces (also a Seq Scan, twice). A
//     partial index on `(recipient) where kind = 'chess_invite' and recipient_user_id is null` would take it from ~4300 to ~18 cost units;
//     that is a schema change and so the migration's owner's call, not this file's. The `magic_link` delete in step 1 is a Seq Scan too, as
//     it has always been.
//
// Runs on the caller's PRIVILEGED transaction (the route's `sql.begin`): `app_user` holds INSERT only on `email_outbox` (V470), so a tenant
// transaction would be refused. It must run in the SAME transaction as the account's anonymisation, so the address is never left behind an
// anonymised account (a failure here fails the deletion, which the person can retry).
import type { Tx } from "@/lib/db";
import type { OutboxKind } from "./constants";
import type { EndedRow } from "./hooks";

/** Why a queued row was ended: the row's `last_error`, a closed reason and never free text. */
export const ACCOUNT_DELETED_REASON = "account_deleted";

/**
 * The address a deleted account is given in place of its own (`users.email` after the deletion route anonymises it), and the recipient a
 * row of that account is left with. One function so the route, the send-time resolution (`recipient.ts`) and the deletion sweep cannot
 * disagree: a reserved TLD (`.invalid`, RFC 2606), so nothing sent to it is ever delivered.
 */
export const deletedAccountPlaceholder = (userId: string): string => `deleted-${userId}@deleted.invalid`;

type EndedRecord = { id: string; kind: OutboxKind; ref_type: string; ref_id: string; meta: Record<string, string> };

/** The account arm: every row that names the account, at whatever address. Served by `email_outbox_recipient_user_idx`. */
const namesAccount = (tx: Tx, userId: string) => tx`recipient_user_id = ${userId}`;
/** The legacy arm: a chess invite from before V472, no user id, at the address EXACTLY (no case folding). */
const legacyInviteAt = (tx: Tx, email: string) => tx`kind = 'chess_invite' and recipient_user_id is null and recipient = ${email}`;

type Predicate = ReturnType<typeof namesAccount>;

const toEnded = (r: EndedRecord): EndedRow => ({ id: r.id, kind: r.kind, refType: r.ref_type, refId: r.ref_id, status: "expired", meta: r.meta });

/**
 * Delete the account's sign-in links, end the account's queued rows and take the address out of all of its rows (see the header).
 * Returns the rows it ended, for the caller to hand to `afterEndedBadly` AFTER the transaction commits.
 *
 * `email` is the address as `users.email` stores it now, `placeholder` what the account is about to be given instead.
 */
export async function anonymiseAccountEmails(tx: Tx, a: { userId: string; email: string; placeholder: string }): Promise<EndedRow[]> {
  await tx`
    delete from email_outbox
     where kind = 'magic_link'
       and (ref_id = ${a.userId} or recipient = ${a.email})`;

  // Ended first, while the rows still hold the address the legacy arm finds them by; the scrub below then replaces it.
  const endQueued = (where: Predicate) => tx<EndedRecord[]>`
    update email_outbox
       set status = 'expired', body_sealed = null, lease_until = null, last_error = ${ACCOUNT_DELETED_REASON},
           status_at = now()
     where ${where} and status = 'queued'
    returning id, kind, ref_type, ref_id, meta`;
  const ended = [...(await endQueued(namesAccount(tx, a.userId))), ...(await endQueued(legacyInviteAt(tx, a.email)))];

  await tx`update email_outbox set recipient = ${a.placeholder} where ${namesAccount(tx, a.userId)}`;
  await tx`update email_outbox set recipient = ${a.placeholder} where ${legacyInviteAt(tx, a.email)}`;

  return ended.map(toEnded);
}
