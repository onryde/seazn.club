import "server-only";
// Writing an outbox row (spec "Sending"): `enqueueEmail(db, message)` inserts on the handle it is given, so a caller
// inside `withTenant` / `sql.begin` queues the email in the SAME transaction as the thing that caused it (committed <=>
// queued; a rollback queues nothing). It never calls Resend; `dispatchNow` does, after the caller commits.
//
// Two constraints from the schema (V470):
//  - `app_user` holds INSERT only, so the id is made here and the insert has no RETURNING (RETURNING needs SELECT);
//  - the replace trigger supersedes older non-terminal rows for the same kind + ref + recipient on this very insert.
import { randomUUID } from "node:crypto";
import type { Tx, sql } from "@/lib/db";
import { MAX_EXPIRY_MS, RETRYABLE_STATUSES, type OutboxKind } from "./constants";
import { sealBody } from "./seal";

export type OutboxMessage = {
  kind: OutboxKind;
  /** What the email is about, scoped by kind (a chess invite: the board and seat). With `refId` and the recipient it is
   *  the key a newer row replaces an older one by. */
  refType: string;
  refId: string;
  orgId: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Transactional mail ignores the marketing suppression list (the sign-in link must always be tried). */
  transactional: boolean;
  /** After this the email is worthless; the row ends `expired`, unsent. At most `MAX_EXPIRY_MS` from now: further out
   *  and `enqueueEmail` refuses with `OutboxExpiryTooLongError`. */
  expiresAt: Date;
  /** Non-secret data a kind's hooks need later (ids, stamps). Never a token, never a body. */
  meta?: Record<string, string>;
};

/** Raised by `enqueueEmail` when `expiresAt` is further out than `MAX_EXPIRY_MS` (or is not a date): such a row could be
 *  re-sent after Resend's idempotency key died. Names the kind and ref type and the bound; never the address or the body. */
export class OutboxExpiryTooLongError extends Error {
  readonly code = "EMAIL_OUTBOX_EXPIRY_TOO_LONG";
  readonly maxMs = MAX_EXPIRY_MS;
  constructor(kind: OutboxKind, refType: string) {
    super(
      `email outbox: a ${kind} email (${refType}) expires further out than ${MAX_EXPIRY_MS} ms (Resend's idempotency key ` +
        "life less a margin), or its expiry is not a date, so a retry could be sent twice; refusing to queue the email",
    );
    this.name = "OutboxExpiryTooLongError";
  }
}

/**
 * Insert one queued row on `db` and return its id (client-made). Throws, BEFORE any statement, so the caller's
 * transaction refuses as a whole:
 *  - `OutboxExpiryTooLongError` when `expiresAt` is more than `MAX_EXPIRY_MS` from now (or not a date);
 *  - `OutboxKeyUnavailableError` when the box can send mail but cannot seal the body.
 * A past `expiresAt` is accepted: that row simply ends `expired`, unsent.
 */
export async function enqueueEmail(db: Tx | typeof sql, m: OutboxMessage): Promise<string> {
  // `!(x <= max)` and not `x > max`: an Invalid Date is NaN, and NaN compares false both ways.
  if (!(m.expiresAt.getTime() - Date.now() <= MAX_EXPIRY_MS)) throw new OutboxExpiryTooLongError(m.kind, m.refType);
  const id = randomUUID();
  const sealed = sealBody({ html: m.html, text: m.text });
  await db`
    insert into email_outbox
      (id, kind, ref_type, ref_id, org_id, meta, recipient, subject, body_sealed, transactional, expires_at)
    values
      (${id}, ${m.kind}, ${m.refType}, ${m.refId}, ${m.orgId}, ${db.json(m.meta ?? {})}, ${m.to}, ${m.subject},
       ${sealed}, ${m.transactional}, ${m.expiresAt})`;
  return id;
}

/**
 * Move the expiry of the chess invites for these refs that can still be sent (`queued`, `sending`) to `expiresAt`: a check-in
 * extension moved the board's deadline later, and an invite whose `expires_at` stayed at the old deadline would be ended `expired`,
 * unsent, by the worker's next tick (Task 8, Review Focus 1). Returns how many rows it matched.
 *
 * Three guards, each in the statement itself:
 *  - it never SHORTENS (`greatest(expires_at, ...)`): an earlier or equal deadline leaves the row as it was;
 *  - it never pushes a row past what Resend's idempotency key still covers (T8-R2): the new value is clamped to
 *    `created_at + MAX_EXPIRY_MS`, the bound `enqueueEmail` holds a new row to, because a retry after the key lapsed could mail
 *    twice. The clamp is applied to the NEW value before the `greatest`, so a row that is already past it (enqueue allows a few
 *    seconds of clock skew) is left exactly as it is: not pulled back, not pushed further;
 *  - only `kind = 'chess_invite'` rows of this `refType` and these refs, in a retryable status: a sent, delivered or otherwise
 *    finished row has nothing to retry, and a sign-in link's expiry is its own.
 *
 * `exceptIds` are rows the caller decided NOT to carry forward: their expiry stays where it was, so they end `expired` unsent at the
 * old deadline instead of being mailed after it (the check-in extension passes the invites it could not re-render for the new
 * deadline - their body still names the old one - see `requeueUnsentInvites`).
 *
 * T8-R1: runs on the caller's PRIVILEGED transaction (checkin-extend's `sql.begin`, the pooled connection the worker uses too).
 * V470 gives `app_user` INSERT only, so a tenant transaction is refused (42501) rather than matching zero rows; there is nothing to
 * fall back to and nothing for a definer function to add. `refIds` carry a board's id, so no other organisation can share one.
 */
export async function extendEmailExpiry(
  db: Tx | typeof sql,
  refType: string,
  refIds: readonly string[],
  expiresAt: Date,
  exceptIds: readonly string[] = [],
): Promise<number> {
  if (refIds.length === 0) return 0;
  const rows = await db`
    update email_outbox
       set expires_at = greatest(
             expires_at,
             least(${expiresAt}::timestamptz, created_at + make_interval(secs => ${MAX_EXPIRY_MS / 1000})))
     where kind = 'chess_invite' and ref_type = ${refType} and ref_id = any(${refIds as string[]}::text[])
       and status = any(${RETRYABLE_STATUSES as string[]}::text[])
       and not (id = any(${exceptIds as string[]}::uuid[]))
    returning id`;
  return rows.length;
}

/**
 * A fresh row that STANDS IN for a retired one (a re-rendered email, in the retired row's place) keeps the retired row's place in the
 * retry schedule: its `attempts`, its `next_attempt_at` and its `last_error` are copied from the row it replaced, matched by kind,
 * ref, recipient (case-folded, as the replace trigger matches) and organisation. Returns how many fresh rows it set.
 *
 * Why, and not a fresh start: the schedule is a bound (`MAX_ATTEMPTS` sends, `RETRY_DELAYS_MS` apart) that spares the provider and
 * the player, and a row that was waiting an hour for its next try should wait that hour still. A fresh row would be tried at once
 * by the request that wrote it and start the whole schedule over, once per re-render. The copy is the only thing the fresh row
 * inherits: its id (and so its idempotency key), body and expiry are its own.
 *
 * Only a retired row that was ATTEMPTED (`attempts > 0`) passes anything on: a never-attempted one leaves the fresh row exactly
 * as `enqueueEmail` wrote it, due at once and owned by the request's `dispatchNow` (the first-attempt window). Runs on the caller's
 * transaction, after the fresh rows are written; the retired rows the fresh ones replaced are `replaced` by then and keep these
 * columns. (A retired row is replaced only if its recipient got a fresh row: the caller counts what it expects to be carried
 * against what this returns, and says so when they differ.)
 */
export async function carryRetryBudget(
  db: Tx | typeof sql,
  retiredIds: readonly string[],
  freshIds: readonly string[],
): Promise<number> {
  if (retiredIds.length === 0 || freshIds.length === 0) return 0;
  const rows = await db`
    update email_outbox n
       set attempts = o.attempts, next_attempt_at = o.next_attempt_at, last_error = o.last_error
      from email_outbox o
     where n.id = any(${freshIds as string[]}::uuid[]) and o.id = any(${retiredIds as string[]}::uuid[])
       and n.status = 'queued' and o.attempts > 0
       and n.kind = o.kind and n.ref_type = o.ref_type and n.ref_id = o.ref_id and lower(n.recipient) = lower(o.recipient)
       and n.org_id is not distinct from o.org_id
    returning n.id`;
  return rows.length;
}
