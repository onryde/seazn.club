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
//   - mail ABOUT the account (wave 3: its verification and its email change, `ACCOUNT_MAIL_KINDS`), found by its ref `user / <the account>`.
//     These kinds are addressed to a literal address and name no account, so neither arm above reaches them; the ref is the account, at
//     whatever address the row holds (the email-change confirmation goes to the NEW address).
//   - NOT a row of any other literal-address kind (`registration_confirmation`, an org's invite ...) queued to the account's address. It is
//     the organiser's: an entry, a payment, a refund or an invite they keep their record of (D5). A row is the account's only if it names
//     the account, or is one of the account's own kinds about it.
//
// RESIDUAL (accepted): a pre-V472 invite queued to an address the account has SINCE CHANGED AWAY FROM is reached by neither arm. It names no
// account (the account arm cannot find it) and no longer holds the account's current address (the legacy arm cannot find it), so that old
// address stays in the row until the 90-day retention removes it. It cannot be claimed by matching the old address either: nothing says the
// account still owns it, and the previous owner of an address is ambiguous (another account may hold it now, and a match would scrub that
// account's row). Rows written since V472 carry the id and have no such gap (F3).
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
// EACH OF STEPS 2 AND 3 IS THREE STATEMENTS, ONE PER ARM, and each arm is index-served (EXPLAIN on 100k rows):
//   - the account arm (every row since V472, the arm that grows): a Bitmap Index Scan on `email_outbox_recipient_user_idx`;
//   - the legacy arm's SCRUB (all statuses): an Index Scan on `email_outbox_legacy_invite_idx`, V472's partial index on `(recipient) where
//     kind = 'chess_invite' and recipient_user_id is null`. It is plain `recipient`, not `lower(recipient)`, because this arm does not fold
//     case; before the index this one statement read the whole table (cost ~4300, now ~23);
//   - the legacy arm's END is the same predicate plus `status = 'queued'`, so the same index serves it (the planner may prefer the partial
//     `queued` index instead; which one it takes is not pinned);
//   - the account-mail arm (both statements): an Index Scan on `email_outbox_ref_idx` (V470, `(ref_type, ref_id, created_at desc)`, not
//     partial), the ref as the `Index Cond` and the kind as a Filter (read with sequential scans off, as the test pins it; not measured on
//     100k rows). `email_outbox_replace_idx` leads on the kind too, but it is partial on the live statuses, so it cannot serve the scrub,
//     which touches every status.
// With that index even a single `a or b` statement would be a BitmapOr of the two, so the split is for clarity (each arm's access path is
// stated and pinned alone, account-deletion-sweep.test.ts) and no longer for the planner. The `magic_link` delete in step 1 is a Seq Scan,
// as it has always been (it matches `ref_id` or `recipient` on a kind, and no index leads on either).
//
// Runs on the caller's PRIVILEGED transaction (the route's `sql.begin`): `app_user` holds INSERT only on `email_outbox` (V470), so a tenant
// transaction would be refused. It must run in the SAME transaction as the account's anonymisation, so the address is never left behind an
// anonymised account (a failure here fails the deletion, which the person can retry).
import type { Tx } from "@/lib/db";
import { ACCOUNT_MAIL_KINDS, type OutboxKind } from "./constants";
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

/** The account arm: every row that names the account, at whatever address. Served by `email_outbox_recipient_user_idx`. Parenthesised, like
 *  its sibling, so a caller may compose it under `and`, `or` or `not` without re-reading its insides. */
export const namesAccount = (tx: Tx, userId: string) => tx`(recipient_user_id = ${userId})`;
/** The legacy arm: a chess invite from before V472, no user id, at the address EXACTLY (no case folding). */
export const legacyInviteAt = (tx: Tx, email: string) => tx`(kind = 'chess_invite' and recipient_user_id is null and recipient = ${email})`;
/** The account-mail arm: the account's own verification and email-change mail, by its ref (a literal kind names no account). Served by
 *  `email_outbox_ref_idx`. */
export const accountMail = (tx: Tx, userId: string) =>
  tx`(kind = any(${ACCOUNT_MAIL_KINDS as string[]}::text[]) and ref_type = 'user' and ref_id = ${userId})`;

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
  const ended = [
    ...(await endQueued(namesAccount(tx, a.userId))),
    ...(await endQueued(legacyInviteAt(tx, a.email))),
    ...(await endQueued(accountMail(tx, a.userId))),
  ];

  await tx`update email_outbox set recipient = ${a.placeholder} where ${namesAccount(tx, a.userId)}`;
  await tx`update email_outbox set recipient = ${a.placeholder} where ${legacyInviteAt(tx, a.email)}`;
  await tx`update email_outbox set recipient = ${a.placeholder} where ${accountMail(tx, a.userId)}`;

  return ended.map(toEnded);
}
