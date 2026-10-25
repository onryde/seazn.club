import "server-only";
// Who an email is sent TO, decided when it is sent (phase 3 spec §6; plan wave 1 T3).
//
// A row for an ACCOUNT (`recipient_user_id` set: the kinds `OUTBOX_KIND_FACTS` marks `account`) stores the address the account had
// when the row was queued. Between then and the attempt the account may have changed its address, or been deleted:
//
//   - deleted        -> nothing is mailed. The caller ends the row `expired` / `account_deleted` with the placeholder in place of the address.
//   - same address   -> sent to the row's recipient (compared without case: the row keeps the spelling it was queued with).
//   - changed address, and the idempotency key is CLEAN (`isKeyClean`) -> the row's recipient is rewritten to the new address and
//                       that is mailed, under the same key as ever. The rewrite keeps phase 2's readers honest: they find a row by
//                       the seat's CURRENT address, so a row left at the old one would read as "Not delivered" for a mail that went out.
//   - changed address, key NOT clean -> the row's own recipient, unchanged (D2).
//
// WHY THE KEY MATTERS (D2). Resend keeps one message per `Idempotency-Key` for 24 h. A send that may already have reached Resend
// (an earlier attempt answered 5xx or never answered, or a lease lapsed mid-attempt) may have created that message. Re-sending the
// same key to a DIFFERENT address is refused by Resend as `invalid_idempotent_request` (the row would go dead), and under a fresh key
// it would be a second email. So an address change is followed only while no request can have left under the key; otherwise the mail
// goes where the first request did, and the person who moved gets nothing a second time. That cost is accepted (spec D2).
//
// A row with no account (`recipient_user_id` null: the literal-address kinds, and phase-1 chess invites) is sent exactly as
// stored. Nothing here reads the address of a row that has no account.
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { deletedAccountPlaceholder } from "./account-deletion";
import type { ClaimedRow } from "./attempt";

/** What the last attempt's `last_error` says when Resend answered 429: `http 429 <name>` (attempt.ts `lastErrorOf`). Anchored on the
 *  status and what follows it, so `http 4290 x` is not a 429. */
const RATE_LIMITED = /^http 429(?: |$)/;

/**
 * May this attempt send to a NEW address under the row's idempotency key? Only when no request under the key can have created a
 * message. The spec's table, over (attempts on the claimed row, the last recorded error, whether the claim reclaimed a lapsed lease):
 *
 *   (1, null,      no )  true   the first attempt: nothing has left.
 *   (2, "http 429", no )  true   the first attempt was refused before it created a message.
 *   (2, "http 503", no )  false  a 5xx may have created the message before failing.
 *   (3, "http 429", no )  false  only the LAST error survives: attempt 1 may have been a 503 that attempt 2's 429 overwrote.
 *   (1, null,      yes)  false  a reclaimed lease: an attempt took the row and its outcome was never recorded.
 *   (2, "http 429", yes)  false  likewise.
 *
 * `attempts` counts THIS attempt (the claim already added it). Anything outside the table is not clean: this fails closed, because
 * the cost of a false "clean" is a second email or a dead row, and the cost of a false "not clean" is an old address.
 */
export function isKeyClean(row: Pick<ClaimedRow, "attempts" | "lastError" | "reclaimed">): boolean {
  if (row.reclaimed) return false;
  if (row.attempts === 1) return true;
  return row.attempts === 2 && row.lastError !== null && RATE_LIMITED.test(row.lastError);
}

/** `send`: mail `to`. `deleted`: the account is gone, mail nothing and end the row with `placeholder` as its recipient. `lost`: the row
 *  stopped being this attempt's while the address was being rewritten (superseded, or re-claimed after a lapsed lease): send nothing,
 *  the attempt that owns the row decides. */
export type Resolution = { kind: "send"; to: string } | { kind: "deleted"; placeholder: string } | { kind: "lost" };

/**
 * Decide where one claimed row goes. Reads the pool (the account is not tenant data) and writes only the rewrite described above, fenced
 * on `status = 'sending' and attempts = <this attempt's number>` like every other write of an attempt. A database failure propagates:
 * nothing has been requested yet, the row stays `sending` with its lease, and the worker reclaims it (as a reclaim, so not key-clean).
 */
export async function resolveRecipient(row: ClaimedRow): Promise<Resolution> {
  if (row.recipientUserId === null) return { kind: "send", to: row.recipient };

  const [user] = await sql<{ email: string; deleted_at: Date | null }[]>`
    select email, deleted_at from users where id = ${row.recipientUserId}`;
  if (!user) {
    // The foreign key (on delete set null) makes a user id with no user impossible. If it happens anyway, the row is still a valid
    // email to a valid address: send it as stored, and say so (ids only; never the address).
    log.error({ outboxId: row.id }, "email outbox: a row names an account that does not exist; it is sent to the address it was queued with");
    return { kind: "send", to: row.recipient };
  }
  if (user.deleted_at !== null) return { kind: "deleted", placeholder: deletedAccountPlaceholder(row.recipientUserId) };
  if (user.email.toLowerCase() === row.recipient.toLowerCase()) return { kind: "send", to: row.recipient };
  if (!isKeyClean(row)) return { kind: "send", to: row.recipient };

  const moved = await sql`
    update email_outbox set recipient = ${user.email}
     where id = ${row.id} and status = 'sending' and attempts = ${row.attempts}
    returning id`;
  if (moved.length === 0) return { kind: "lost" };
  return { kind: "send", to: user.email };
}
