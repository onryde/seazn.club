import "server-only";
import crypto from "node:crypto";
import { sql, type Tx } from "@/lib/db";

const TTL_HOURS = 24;
/** The same TTL in ms: the outbox row that carries the link is worthless once the link is (`expiryWithin` bounds it). */
export const VERIFICATION_TTL_MS = TTL_HOURS * 3600_000;

/** Issue a single-use email verification token for a user, on `db`: the staff resend passes its transaction, so the token and the
 *  outbox row that carries it are committed together or not at all. */
export async function createVerificationToken(userId: string, db: Tx | typeof sql = sql): Promise<string> {
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS).toISOString();
  await db`
    insert into email_verifications (user_id, token, expires_at)
    values (${userId}, ${token}, ${expiresAt})`;
  return token;
}

/**
 * Consume a verification token: delete it and return the user id if it was
 * valid and unexpired, otherwise null.
 */
export async function consumeVerificationToken(
  token: string,
): Promise<string | null> {
  const rows = await sql<{ user_id: string; expires_at: string }[]>`
    select user_id, expires_at from email_verifications
    where token = ${token} limit 1`;
  const row = rows[0];
  if (!row) return null;
  await sql`delete from email_verifications where token = ${token}`;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.user_id;
}
