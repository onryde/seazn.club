import "server-only";
import crypto from "node:crypto";
import { sql, type Tx } from "@/lib/db";

// Short TTL: a login link is a live credential, so it should not linger.
const TTL_MINUTES = 15;
/** The same TTL in ms: the outbox row for the sign-in email expires with the link (never later: a late link is worse than none). */
export const LOGIN_LINK_TTL_MS = TTL_MINUTES * 60_000;

/**
 * Issue a single-use passwordless sign-in token for a user, on `db`: the delete of the earlier unused links and the insert
 * of the new one go through whichever handle the caller holds. The sign-in route passes its transaction, so the token and
 * the outbox row that carries it are committed together or not at all. Returns the token and the instant it stops working
 * (the outbox row for the email expires at exactly that instant).
 */
export async function issueLoginLink(userId: string, db: Tx | typeof sql): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + LOGIN_LINK_TTL_MS);
  // Only one live link per user — invalidate any earlier unused ones.
  await db`delete from login_links where user_id = ${userId} and used = false`;
  await db`
    insert into login_links (user_id, token, expires_at)
    values (${userId}, ${token}, ${expiresAt.toISOString()})`;
  return { token, expiresAt };
}

/** Issue a single-use passwordless sign-in token for a user. */
export async function createLoginLink(userId: string): Promise<string> {
  return (await issueLoginLink(userId, sql)).token;
}

/**
 * Consume a login token: mark it used and return the user id if it was valid
 * and unexpired, otherwise null. Clicking the link proves email ownership, so
 * the account is marked verified in the same transaction.
 *
 * A link whose account has been deleted is an invalid link. A link lives 15
 * minutes and DELETE /api/users/me does not touch `login_links`, so one issued
 * just before the deletion is still unspent and unexpired just after it. The
 * guard is the `deleted_at is null` on the write that verifies the address,
 * and the row it must hit: that statement is the check AND the effect, so a
 * deletion committing between this transaction's first read and its update
 * (the update waits on the deleting transaction's row lock, then re-reads the
 * row) is refused as well, which a separate read-then-write would not be.
 * Nothing is verified, no id is returned, so the route mints no cookie and
 * provisions no organisation for a deleted user. The link is spent: a refused
 * credential does not stay redeemable.
 */
export async function consumeLoginLink(token: string): Promise<string | null> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; user_id: string; expires_at: string; used: boolean }[]>`
      select id, user_id, expires_at, used
      from login_links where token = ${token}
      for update limit 1`;
    const row = rows[0];
    if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }
    await tx`update login_links set used = true where id = ${row.id}`;
    const verified = await tx<{ id: string }[]>`
      update users set email_verified = true
      where id = ${row.user_id} and deleted_at is null
      returning id`;
    if (verified.length === 0) return null;
    return row.user_id;
  });
}
