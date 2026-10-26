import "server-only";
// What the outbox knows about the emails of a thing, and the retention of the rows themselves. They run on the PRIVILEGED connection,
// as the worker does (V470: `app_user` holds INSERT only, so a tenant connection can neither read a row back nor delete one):
// `latestEmailStatus`, `latestStatusesOfRows`, `scrubEndedRecipients` and `purgeOldEmails` on the pooled client, `lockQueuedEmails` on the PRIVILEGED
// TRANSACTION its caller passes in (it takes row locks, which only mean something inside that transaction). None of them sends anything.
//
//  - `latestEmailStatus` is the read the arbiter's phase-2 column will use ("did this seat's invite arrive?"). Its caller is a tenant
//    page, so it takes the organisation explicitly and filters on it (T8-R1): the connection bypasses RLS, so the filter in the
//    statement is the only fence between one club's page and another club's addresses.
//  - `lockQueuedEmails` is the check-in extension's read of what it may still re-render (see enqueue.ts `carryRetryBudget`).
//  - `purgeOldEmails` is the worker's last step (RETENTION_DAYS); `scrubEndedRecipients` runs just before it (step 7a), taking the address
//    out of an ended row of a kind that may keep it only while it can still be sent (SCRUBBED_WHEN_ENDED).
import { sql, type Tx } from "@/lib/db";
import { PURGE_BATCH, RETENTION_DAYS, SCRUBBED_WHEN_ENDED, type OutboxKind, type OutboxStatus } from "./constants";
import { CANCELLED_REASONS } from "./cancel";

// THE RULE for "which row is the email a recipient has about a thing", in one place. THREE statements need it and their call shapes
// differ - `latestEmailStatus` asks by (organisation, ref type, refs) and answers per recipient; `latestStatusesOfRows` asks by row
// id (the rows a request has just written, whose org it owns) and answers per row; `lockQueuedEmails` asks by (kind, ref type, refs)
// and locks what it keeps - so they cannot be one statement, but they share these two fragments and so cannot disagree about what
// "latest" means:
//  - `current`: a `replaced` row is never the answer, even when it is the newest on the clock (the V470 replace trigger supersedes
//    by KEY, not by time, so the row that carries the outcome is the newest one that is not replaced); and neither is a row a VOID
//    ended (`expired` with a cancel reason in `last_error`, cancel.ts): the thing it was about is gone, so it is not "mail this
//    recipient has about the thing". The test is the pair - status AND reason - because `expired` alone also means the worker aged a
//    row out, which IS an answer (the invite never went). Without this skip, a seat re-paired to the same player after an Unpair
//    read the voided row as "Not delivered" (P8, found through the arbiter loader);
//  - `newestFirst`: "newest" is `created_at`, ties by `id` - never `status_at`, which moves with every status change and says
//    nothing about which email is the latest.
// Both are written unqualified on purpose: inside `latestStatusesOfRows`' lateral subselect an unqualified column binds to the inner
// table (`x`), the one being ranked, and not to the outer row.
// `coalesce(..., false)`: an `expired` row the worker aged out has a NULL `last_error`, and `status = 'expired' and null` is null, so a
// bare `not (...)` would be null too and the row would vanish from the answer (a null in a where clause is "no").
const current = () =>
  sql`status <> 'replaced' and not (status = 'expired' and coalesce(last_error = any(${CANCELLED_REASONS as string[]}::text[]), false))`;
const newestFirst = () => sql`created_at desc, id desc`;

/** One recipient's latest email about one thing. `at` is when its status last changed (`status_at`). `recipientUserId` is the account
 *  an account kind's row is for (`recipient_user_id`), null for a row with none (a literal-address kind, or a phase-1 invite): the
 *  address on the row is the one it was queued with, which the account may since have left, so a reader that wants "this person's
 *  mail" matches by the id first (lib/invite-status.ts `seatInviteWords`). */
export type EmailStatusRow = {
  refId: string;
  recipient: string;
  recipientUserId: string | null;
  kind: OutboxKind;
  status: OutboxStatus;
  at: Date;
};

/**
 * The status of the newest email to each recipient of each of these refs, for one organisation and one ref type: one row per
 * (ref, recipient case-folded, as the V470 replace rule folds it), never a `replaced` row and never a row a void ended (`expired`
 * with a cancel reason in `last_error`, see `current`). Either is skipped even when it is the newest on the clock: the replace
 * trigger supersedes by KEY, not by time, and a voided email is mail about a thing that is gone, so the row that carries the
 * outcome is the newest one that is neither. "Newest" is `created_at`, ties by `id` (`status_at` moves with every status change and says nothing about
 * which email is the latest). A resend after a dead row reads as the new row. Empty `refIds` answers `[]` and issues no statement.
 *
 * `kind`, when given, narrows the ask to the emails of that kind BEFORE the newest-per-recipient fold: a ref is "a thing", and the
 * outbox is shared by every kind, so a newer row of another kind on the same ref and mailbox must not become this kind's latest (and a
 * filter applied after the fold would lose the kind's own row behind it). The arbiter asks for `chess_invite`, the only kind that
 * writes a seat ref. Without it every kind answers.
 */
export async function latestEmailStatus(
  orgId: string,
  refType: string,
  refIds: readonly string[],
  kind?: OutboxKind,
): Promise<EmailStatusRow[]> {
  if (refIds.length === 0) return [];
  const rows = await sql<EmailStatusRow[]>`
    select distinct on (ref_id, lower(recipient))
           ref_id as "refId", recipient, recipient_user_id as "recipientUserId", kind, status, status_at as "at"
      from email_outbox
     where org_id = ${orgId} and ref_type = ${refType} and ref_id = any(${refIds as string[]}::text[])
       ${kind === undefined ? sql`` : sql`and kind = ${kind}`}
       and ${current()}
     order by ref_id, lower(recipient), ${newestFirst()}`;
  return rows.map((r) => ({
    refId: r.refId,
    recipient: r.recipient,
    recipientUserId: r.recipientUserId,
    kind: r.kind,
    status: r.status,
    at: r.at,
  }));
}

/**
 * The status NOW of the newest current row (neither `replaced` nor voided, see `current`) for each of these ROWS' kind, ref and recipient (the recipient compared as the
 * replace rule compares it, case-insensitively), keyed by the row asked about. A row the caller wrote and a newer one another
 * request wrote for the same recipient answer alike: the newer row is what the recipient's mail is. The same rule as
 * `latestEmailStatus` (the `current` and `newestFirst` fragments above); asked by row id because its caller (the chess invite, in the
 * request that just queued the rows) holds ids, not an organisation, and has no need of the org fence: they are its own rows.
 * Empty `ids` answers an empty map and issues no statement.
 */
export async function latestStatusesOfRows(ids: readonly string[]): Promise<Map<string, OutboxStatus>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; status: OutboxStatus }[]>`
    select o.id, l.status
      from email_outbox o
      join lateral (
        select x.status from email_outbox x
         where x.kind = o.kind and x.ref_type = o.ref_type and x.ref_id = o.ref_id
           and lower(x.recipient) = lower(o.recipient) and ${current()}
         order by ${newestFirst()}
         limit 1
      ) l on true
     where o.id = any(${ids as string[]}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.status]));
}

/** One email still waiting to be sent, as `lockQueuedEmails` reads it. */
export type QueuedEmailRow = {
  id: string;
  refId: string;
  recipient: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  meta: Record<string, string>;
};

/**
 * The emails of these refs that may still be RE-RENDERED: for each recipient (of each ref, case-folded) the newest current row (neither
 * `replaced` nor voided, see `current`; the SAME rule as `latestEmailStatus` and `latestStatusesOfRows`, the fragments above), kept only when
 *  - its status is `queued` (waiting to go out: a `sending`, `sent`, `delayed`, `delivered` or ended row is out of the caller's hands
 *    or already gone), AND
 *  - no request of it can have reached the provider: it was never attempted (`attempts = 0`), or its ONLY attempt was answered 429
 *    (`attempts = 1` and `http 429 <name>`, the shape `attempt.ts`'s `lastErrorOf` writes: the provider refused the request before it
 *    did anything). `last_error` is only the LAST answer: with two or more attempts an earlier one may have been a network error or a
 *    5xx that the provider accepted, so a 429 after them proves nothing and the row is not eligible.
 * and LOCKED (`for update`) on the caller's transaction.
 *
 * The second test is the one that keeps the promise "never an extra mail", and it is the SAME rule as recipient.ts `isKeyClean`
 * (may a request under this row's key have left?), judged one moment earlier: here the row is not yet claimed, so `attempts` does not
 * yet count the attempt that `isKeyClean` sees (attempts + 1 there). recipient-resolution.test.ts drives a grid of
 * (attempts, last_error) through both and asserts they agree. A re-rendered email is a NEW row, so a new idempotency
 * key (`idempotencyKey(row.id)`). A row whose earlier attempt ended in a network error, a 5xx or a 409 in-flight answer may have been
 * ACCEPTED with the answer lost; the same key would make its retry harmless, but a fresh key would mail the recipient a second time.
 * Such a row is not returned: it keeps its key and its body (naming the deadline it was written with), and the caller moves only its
 * expiry. Carrying the old key onto the fresh row is not an option either: the same key with a different payload is a 409
 * `invalid_idempotent_request`, which ends the row `dead` and lets the chess hook release a seat whose first mail did arrive.
 *
 * The lock is what makes the status trustworthy. A send claims a row with an UPDATE on `status = 'queued'`; asking for the row's
 * lock first means the caller either waits for that claim and then finds the row `sending` (so it is not returned), or holds the
 * lock before the claim and the claim waits for the caller's commit and then finds the row replaced. Without it the caller could
 * retire a row a send is delivering at that moment, and mail the recipient twice.
 *
 * The caller needs the PRIVILEGED transaction (`sql.begin`): V470 gives `app_user` INSERT only. The newest-row rule is one
 * subselect and the status and attempt tests are outside it, once: the filter is the guard, and the lock is taken on exactly what
 * survives it.
 */
export async function lockQueuedEmails(
  db: Tx,
  kind: OutboxKind,
  refType: string,
  refIds: readonly string[],
): Promise<QueuedEmailRow[]> {
  if (refIds.length === 0) return [];
  return db<QueuedEmailRow[]>`
    select o.id, o.ref_id as "refId", o.recipient, o.attempts, o.next_attempt_at as "nextAttemptAt",
           o.last_error as "lastError", o.meta
      from email_outbox o
     where o.id in (
             select distinct on (ref_id, lower(recipient)) id
               from email_outbox
              where kind = ${kind} and ref_type = ${refType} and ref_id = any(${refIds as string[]}::text[])
                and ${current()}
              order by ref_id, lower(recipient), ${newestFirst()})
       and o.status = 'queued'
       and (o.attempts = 0 or (o.attempts = 1 and o.last_error like 'http 429 %'))
     order by o.ref_id, o.id
       for update of o`;
}

/** Exactly RETENTION_DAYS of 24 h, in seconds: an `interval '90 days'` would shift by an hour across a DST change in the session's
 *  time zone, and the boundary the tests pin is a minute wide. */
const RETENTION_SECS = RETENTION_DAYS * 24 * 3600;

export type PurgeOptions = {
  /** TEST SEAM ONLY (the worker's tick passes its own `onlyIds` through; the route never passes any): restrict the delete to these
   *  row ids. Test files share one database, and an unscoped purge removes any file's old rows. `[]` means "no row", not "every row". */
  onlyIds?: readonly string[];
  /** TEST SEAM ONLY: run on this handle, so a test can exercise the unscoped statement inside a transaction it rolls back. */
  db?: Tx | typeof sql;
};

/**
 * Delete the rows older than RETENTION_DAYS (by `created_at`), whatever their status, in ONE bounded statement: at most PURGE_BATCH,
 * the oldest first, skipping a row another transaction holds (an overlapping tick takes different rows). Returns how many it
 * deleted; a backlog drains over the next calls. Nothing references `email_outbox`, so there is nothing to cascade.
 */
export async function purgeOldEmails(opts: PurgeOptions = {}): Promise<number> {
  const db = opts.db ?? sql;
  const scope = opts.onlyIds === undefined ? db`` : db`and id = any(${opts.onlyIds as string[]}::uuid[])`;
  const rows = await db`
    with doomed as (
      select id from email_outbox
       where created_at < now() - make_interval(secs => ${RETENTION_SECS}) ${scope}
       order by created_at, id
       limit ${PURGE_BATCH}
       for update skip locked
    )
    delete from email_outbox o using doomed where o.id = doomed.id
    returning o.id`;
  return rows.length;
}

/**
 * Take the address out of the ENDED rows of the kinds that may hold it only while they can still be sent (SCRUBBED_WHEN_ENDED: the
 * deletion notice, P-W3-6), in ONE bounded statement with the purge's shape: at most PURGE_BATCH, the oldest first, skipping a row another
 * transaction holds. "Ended" is every status but `queued` and `sending`: a row that can still be sent keeps the address it must be sent to,
 * and every way a row ends (an attempt's outcome, the worker's expiry and dead steps, a cancel) leaves it in one of the others, so one
 * statement covers all of them and the address lives at most one tick after the row ends.
 *
 * The placeholder is the deleted account's own, built from the row's `user / <account>` ref in the same format as `deletedAccountPlaceholder`
 * (account-deletion.ts), which is what the deletion writes to `users.email`; a row that already holds it is not touched again. Returns how
 * many rows it scrubbed. SQL only: it reads no body and renders nothing.
 */
export async function scrubEndedRecipients(opts: PurgeOptions = {}): Promise<number> {
  const db = opts.db ?? sql;
  const scope = opts.onlyIds === undefined ? db`` : db`and id = any(${opts.onlyIds as string[]}::uuid[])`;
  const rows = await db`
    with ended as (
      select id from email_outbox
       where kind = any(${SCRUBBED_WHEN_ENDED as string[]}::text[]) and ref_type = 'user'
         and status not in ('queued', 'sending')
         and recipient <> 'deleted-' || ref_id || '@deleted.invalid' ${scope}
       order by created_at, id
       limit ${PURGE_BATCH}
       for update skip locked
    )
    update email_outbox o set recipient = 'deleted-' || o.ref_id || '@deleted.invalid' from ended where o.id = ended.id
    returning o.id`;
  return rows.length;
}
