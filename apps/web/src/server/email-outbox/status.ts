import "server-only";
// What the outbox knows about the emails of a thing, and the retention of the rows themselves. Both run on the PRIVILEGED pooled
// connection, as the worker does (V469: `app_user` holds INSERT only, so a tenant connection can neither read a row back nor delete
// one). Neither sends anything.
//
//  - `latestEmailStatus` is the read the arbiter's phase-2 column will use ("did this seat's invite arrive?"). Its caller is a tenant
//    page, so it takes the organisation explicitly and filters on it (T8-R1): the connection bypasses RLS, so the filter in the
//    statement is the only fence between one club's page and another club's addresses.
//  - `purgeOldEmails` is the worker's last step (RETENTION_DAYS).
import { sql, type Tx } from "@/lib/db";
import { PURGE_BATCH, RETENTION_DAYS, type OutboxKind, type OutboxStatus } from "./constants";

/** One recipient's latest email about one thing. `at` is when its status last changed (`status_at`). */
export type EmailStatusRow = { refId: string; recipient: string; kind: OutboxKind; status: OutboxStatus; at: Date };

/**
 * The status of the newest email to each recipient of each of these refs, for one organisation and one ref type: one row per
 * (ref, recipient case-folded, as the V469 replace rule folds it), never a `replaced` row. A `replaced` row is skipped even when
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
       and status <> 'replaced'
     order by ref_id, lower(recipient), created_at desc, id desc`;
  return rows.map((r) => ({ refId: r.refId, recipient: r.recipient, kind: r.kind, status: r.status, at: r.at }));
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
