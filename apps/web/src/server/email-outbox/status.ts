import "server-only";
// What the outbox knows about the emails of a thing, and the retention of the rows themselves. Both run on the PRIVILEGED pooled
// connection, as the worker does (V470: `app_user` holds INSERT only, so a tenant connection can neither read a row back nor delete
// one). Neither sends anything.
//
//  - `latestEmailStatus` is the read the arbiter's phase-2 column will use ("did this seat's invite arrive?"). Its caller is a tenant
//    page, so it takes the organisation explicitly and filters on it (T8-R1): the connection bypasses RLS, so the filter in the
//    statement is the only fence between one club's page and another club's addresses.
//  - `lockQueuedEmails` is the check-in extension's read of what has not gone out yet (it re-renders those emails; see enqueue.ts
//    `carryRetryBudget`), locked on the caller's own transaction.
//  - `purgeOldEmails` is the worker's last step (RETENTION_DAYS).
import { sql, type Tx } from "@/lib/db";
import { PURGE_BATCH, RETENTION_DAYS, type OutboxKind, type OutboxStatus } from "./constants";

// THE RULE for "which row is the email a recipient has about a thing", in one place. Two reads need it and their call shapes
// differ - `latestEmailStatus` asks by (organisation, ref type, refs) and answers per recipient; `latestStatusesOfRows` asks by row
// id (the rows a request has just written, whose org it owns) and answers per row - so they cannot be one statement, but they
// share these two fragments and so cannot disagree about what "latest" means:
//  - `current`: a `replaced` row is never the answer, even when it is the newest on the clock (the V470 replace trigger supersedes
//    by KEY, not by time, so the row that carries the outcome is the newest one that is not replaced);
//  - `newestFirst`: "newest" is `created_at`, ties by `id` - never `status_at`, which moves with every status change and says
//    nothing about which email is the latest.
// Both are written unqualified on purpose: inside `latestStatusesOfRows`' lateral subselect an unqualified column binds to the inner
// table (`x`), the one being ranked, and not to the outer row.
const current = () => sql`status <> 'replaced'`;
const newestFirst = () => sql`created_at desc, id desc`;

/** One recipient's latest email about one thing. `at` is when its status last changed (`status_at`). */
export type EmailStatusRow = { refId: string; recipient: string; kind: OutboxKind; status: OutboxStatus; at: Date };

/**
 * The status of the newest email to each recipient of each of these refs, for one organisation and one ref type: one row per
 * (ref, recipient case-folded, as the V470 replace rule folds it), never a `replaced` row. A `replaced` row is skipped even when
 * it is the newest on the clock: the replace trigger supersedes by KEY, not by time, so the row that carries the outcome is the
 * newest one that is not. "Newest" is `created_at`, ties by `id` (`status_at` moves with every status change and says nothing about
 * which email is the latest). A resend after a dead row reads as the new row. Empty `refIds` answers `[]` and issues no statement.
 */
export async function latestEmailStatus(
  orgId: string,
  refType: string,
  refIds: readonly string[],
): Promise<EmailStatusRow[]> {
  if (refIds.length === 0) return [];
  const rows = await sql<{ refId: string; recipient: string; kind: OutboxKind; status: OutboxStatus; at: Date }[]>`
    select distinct on (ref_id, lower(recipient))
           ref_id as "refId", recipient, kind, status, status_at as "at"
      from email_outbox
     where org_id = ${orgId} and ref_type = ${refType} and ref_id = any(${refIds as string[]}::text[])
       and ${current()}
     order by ref_id, lower(recipient), ${newestFirst()}`;
  return rows.map((r) => ({ refId: r.refId, recipient: r.recipient, kind: r.kind, status: r.status, at: r.at }));
}

/**
 * The status NOW of the newest non-replaced row for each of these ROWS' kind, ref and recipient (the recipient compared as the
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
 * The emails of these refs that have not gone out and are still on the books: for each recipient (of each ref, case-folded) the
 * newest non-replaced row (the SAME rule as `latestEmailStatus` and `latestStatusesOfRows`, the fragments above), kept only when its
 * status is `queued` - never attempted, or waiting for a retry - and LOCKED (`for update`) on the caller's transaction. A row
 * that is `sending`, `sent`, `delayed`, `delivered` or ended is not returned: it is out of the caller's hands or already gone.
 *
 * The lock is what makes the status trustworthy. A send claims a row with an UPDATE on `status = 'queued'`; asking for the row's
 * lock first means the caller either waits for that claim and then finds the row `sending` (so it is not returned), or holds the
 * lock before the claim and the claim waits for the caller's commit and then finds the row replaced. Without it the caller could
 * retire a row a send is delivering at that moment, and mail the recipient twice.
 *
 * The caller needs the PRIVILEGED transaction (`sql.begin`): V470 gives `app_user` INSERT only. The newest-row rule is one
 * subselect and the status test is outside it, once: the filter is the guard, and the lock is taken on exactly what survives it.
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
