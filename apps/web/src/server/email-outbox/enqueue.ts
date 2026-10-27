import "server-only";
// Writing an outbox row (spec "Sending"): `enqueueEmail(db, message)` inserts on the handle it is given, so a caller
// inside `withTenant` / `sql.begin` queues the email in the SAME transaction as the thing that caused it (committed <=>
// queued; a rollback queues nothing). It never calls Resend; `dispatchNow` does, after the caller commits.
//
// Constraints from the schema (V470, V472):
//  - `app_user` holds INSERT only, so the id is made here and the insert has no RETURNING (RETURNING needs SELECT);
//  - the replace trigger supersedes older non-terminal rows for the same kind + ref + recipient AFTER this very insert;
//  - the insert ends `on conflict do nothing` with NO conflict target (plan P1). A target (`on conflict (kind, dedupe_key)
//    where ...`) needs SELECT on its columns and fails 42501 for `app_user`. The price: the clause swallows ANY unique
//    violation, so the table may carry exactly the unique indexes it is meant to swallow (the primary key,
//    `email_outbox_provider_idx` and `email_outbox_once_idx`; outbox-once-key.test.ts reads the catalogue), and a writer
//    that wrote nothing for a reason other than its once-key must say so (`OutboxInsertSkippedError`).
import { randomUUID } from "node:crypto";
import type { Tx, sql } from "@/lib/db";
import { MAX_EXPIRY_MS, OUTBOX_KIND_FACTS, RETRYABLE_STATUSES, type OutboxKind } from "./constants";
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
  /** The account this email is for, when `OUTBOX_KIND_FACTS[kind].to` is `account`: the address is then resolved from the
   *  account at send time, and the replace rule matches by this id. A literal-address or staff kind must NOT carry one
   *  (`OutboxKindMismatchError`). */
  recipientUserId?: string;
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

/** Raised when a message carries `recipientUserId` but its kind is not addressed to an account (`OUTBOX_KIND_FACTS[kind].to`
 *  is not `account`: a literal address, or the staff address): the id would never be read, and a replace rule that matched by
 *  it would silently pair rows it should not. Names the kind and ref type; never the address or the id. */
export class OutboxKindMismatchError extends Error {
  readonly code = "EMAIL_OUTBOX_KIND_MISMATCH";
  constructor(kind: OutboxKind, refType: string) {
    super(
      `email outbox: a ${kind} email (${refType}) is not addressed to an account, so it must not carry an account id ` +
        "(recipientUserId); refusing to queue the email",
    );
    this.name = "OutboxKindMismatchError";
  }
}

/** Raised by `enqueueEmailOnce` when its once-key is not a non-blank string. A blank key would be one shared "blank" key for the whole
 *  kind (the table's CHECK only refuses the empty string, and does so as a 23514 that aborts the caller's transaction), silencing every
 *  later email of the kind. Names the kind and ref type; never the key, the address or the body. */
export class OutboxDedupeKeyError extends Error {
  readonly code = "EMAIL_OUTBOX_BAD_DEDUPE_KEY";
  constructor(kind: OutboxKind, refType: string) {
    super(`email outbox: a ${kind} email (${refType}) was given a once-key that is empty or blank; refusing to queue the email`);
    this.name = "OutboxDedupeKeyError";
  }
}

/**
 * The once-key for an email about `id` (a row UUID or a Stripe id): `id`, or `<id>:<suffix>` when one fact owes several emails (a
 * dispute's `created`, `won`, `lost`). Refuses a missing or blank id by name (`OutboxDedupeKeyError`), before any key exists: the
 * blank check in `enqueueEmailOnce` cannot see one, because `${undefined}:created` is not blank, and a key that lost its id is one key
 * for the whole kind in EVERY organisation (the index is global, ruling R-T1f), so every later email of the kind would be skipped.
 */
export function onceKey(kind: OutboxKind, refType: string, id: string | null | undefined, suffix?: string): string {
  if (typeof id !== "string" || id.trim() === "") throw new OutboxDedupeKeyError(kind, refType);
  return suffix === undefined ? id : `${id}:${suffix}`;
}

/** Raised by `enqueueEmail` when its insert wrote no row. The writer's `on conflict do nothing` has no target (see the header),
 *  so a primary-key or provider-id collision is skipped as quietly as a once-key; without this a caller would be handed the id
 *  of a row that was never written. Names the kind and ref type; never the address or the body. */
export class OutboxInsertSkippedError extends Error {
  readonly code = "EMAIL_OUTBOX_INSERT_SKIPPED";
  constructor(kind: OutboxKind, refType: string) {
    super(
      `email outbox: the insert of a ${kind} email (${refType}) wrote no row and no once-key explains it ` +
        "(a primary-key or provider-id collision); refusing to report it queued",
    );
    this.name = "OutboxInsertSkippedError";
  }
}

/**
 * The `expiresAt` for an email that is worthless after `deadline` (the end of the thing it is about; `null` when it has no
 * end): the deadline, but never further out than `MAX_EXPIRY_MS` from `nowMs`, the bound `enqueueEmail` holds every row to. A
 * deadline already past is returned as it is (the row simply ends `expired`, unsent). An Invalid Date stays invalid, so the
 * writer still refuses it by name rather than the bound laundering it.
 */
export function expiryWithin(deadline: Date | null, nowMs: number = Date.now()): Date {
  return new Date(Math.min(deadline?.getTime() ?? Infinity, nowMs + MAX_EXPIRY_MS));
}

/**
 * The one insert both writers share. Throws, BEFORE any statement, so the caller's transaction refuses as a whole:
 *  - `OutboxExpiryTooLongError` when `expiresAt` is more than `MAX_EXPIRY_MS` from now (or not a date);
 *  - `OutboxKindMismatchError` when a kind not addressed to an account (a literal-address or a staff kind) carries
 *    `recipientUserId`;
 *  - `OutboxKeyUnavailableError` when the box can send mail but cannot seal the body.
 * A past `expiresAt` is accepted: that row simply ends `expired`, unsent. Returns the client-made id and how many rows the
 * statement wrote (`on conflict do nothing` writes none when a unique index already holds the row).
 *
 * The facts guard is one-directional on purpose: an account kind without an id and a `transactional` flag that differs from the
 * kind's fact are NOT refused here. Phase-1 call sites enqueue `chess_invite` with no user id, and others pass
 * `transactional: false` on a T kind to reach the suppression gate; the facts harness pins both on every kind's real rows.
 */
async function insertQueued(db: Tx | typeof sql, m: OutboxMessage, dedupeKey: string | null): Promise<{ id: string; written: number }> {
  // `!(x <= max)` and not `x > max`: an Invalid Date is NaN, and NaN compares false both ways.
  if (!(m.expiresAt.getTime() - Date.now() <= MAX_EXPIRY_MS)) throw new OutboxExpiryTooLongError(m.kind, m.refType);
  if (m.recipientUserId !== undefined && OUTBOX_KIND_FACTS[m.kind].to !== "account") throw new OutboxKindMismatchError(m.kind, m.refType);
  const id = randomUUID();
  const sealed = sealBody({ html: m.html, text: m.text });
  const result = await db`
    insert into email_outbox
      (id, kind, ref_type, ref_id, org_id, meta, recipient, subject, body_sealed, transactional, expires_at,
       recipient_user_id, dedupe_key)
    values
      (${id}, ${m.kind}, ${m.refType}, ${m.refId}, ${m.orgId}, ${db.json(m.meta ?? {})}, ${m.to}, ${m.subject},
       ${sealed}, ${m.transactional}, ${m.expiresAt}, ${m.recipientUserId ?? null}, ${dedupeKey})
    on conflict do nothing`;
  return { id, written: result.count };
}

/**
 * Insert one queued row on `db` and return its id (client-made). Throws, BEFORE any statement, on an expiry past the bound, a
 * literal or staff kind that carries an account id, or a box that cannot seal the body (see `insertQueued`). Throws
 * `OutboxInsertSkippedError` when the insert wrote nothing: a row with no once-key is never legitimately skipped.
 */
export async function enqueueEmail(db: Tx | typeof sql, m: OutboxMessage): Promise<string> {
  const { id, written } = await insertQueued(db, m, null);
  // `!(written >= 1)` and not `written === 0`: a count that is not a number (a driver that returned none) is no evidence of a row.
  if (!(written >= 1)) throw new OutboxInsertSkippedError(m.kind, m.refType);
  return id;
}

/**
 * `enqueueEmail` for an email that must exist at most once per `(kind, dedupeKey)`: returns the new row's id, or `null` when
 * the key is already taken (no row written, nothing thrown, the caller's transaction still usable, the original row untouched).
 * The same refusals as `enqueueEmail`, before any statement.
 *
 * THE KEY IS GLOBAL. `email_outbox_once_idx` is unique on `(kind, dedupe_key)` across ALL organisations, not per organisation,
 * so a key must embed a globally unique id (a row UUID or a Stripe id, for example `<registration_id>:submit`), never a
 * per-org counter, a slug or a bare ordinal: two organisations that both built `1:submit` would silence each other's email.
 * A key is freed when `email_outbox_cancel` ends its row, so a voided email can be queued again.
 *
 * `null` also covers a primary-key or provider-id collision, which the target-less clause cannot tell apart; the id is a fresh
 * UUID and `provider_id` is null at insert, so neither happens in practice. Refuses an empty or blank key by name
 * (`OutboxDedupeKeyError`), before the statement.
 */
export async function enqueueEmailOnce(db: Tx | typeof sql, m: OutboxMessage & { dedupeKey: string }): Promise<string | null> {
  // Before any statement, like every refusal here. `typeof` as well as `trim`: a caller that cast around the type with `undefined`
  // would otherwise reach the driver, which throws its own (unnamed) error for an undefined parameter.
  if (typeof m.dedupeKey !== "string" || m.dedupeKey.trim() === "") throw new OutboxDedupeKeyError(m.kind, m.refType);
  const { id, written } = await insertQueued(db, m, m.dedupeKey);
  return written >= 1 ? id : null;
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
