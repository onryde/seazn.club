import "server-only";
// The player payment page's token (plan 2026-11-11-player-payment-page, Task 1; see ./index.ts). A chase mail links
// `/r/pay/<token>`: 32 random bytes shown once inside the mail's url, stored only as their sha256
// (`registration_pay_tokens.token_hash`, V510). A fresh token per mail; every token for an entry stays valid - the entry's
// state, not token revocation, closes the page.
import { sql, type Tx } from "@/lib/db";
import { registrationPayPath } from "@/lib/registration-pay";
import { hashReportToken, mintReportToken } from "@/server/sponsors/report-token";

/** A new pay-page token and the hash that is all the database ever holds of it. */
export function mintPayToken(): { token: string; tokenHash: Buffer } {
  const token = mintReportToken();
  return { token, tokenHash: hashReportToken(token) };
}

/** Records a minted token's hash against its entry. `db` is the pool or a tenant transaction (the row's `org_id` must then be
 *  that transaction's org - RLS checks it). */
export async function recordPayToken(
  db: Tx | typeof sql,
  a: { tokenHash: Buffer; registrationId: string; orgId: string },
): Promise<void> {
  await db`
    insert into registration_pay_tokens (token_hash, registration_id, org_id)
    values (${a.tokenHash}, ${a.registrationId}, ${a.orgId})`;
}

/** A new pay-page link under `origin`, and the hash to record for it. The raw token leaves only inside `url`. */
export function issuePayLink(origin: string): { url: string; tokenHash: Buffer } {
  const { token, tokenHash } = mintPayToken();
  return { url: `${origin}${registrationPayPath(token)}`, tokenHash };
}

/** The entry a pay-page token opens, or null. Privileged (a visitor has no org yet - the token is what names one). No shape
 *  check and nothing read before the lookup: one statement answers an unknown and a malformed token alike, and the token is in
 *  no log line. */
export async function registrationIdByPayToken(token: string): Promise<string | null> {
  const [row] = await sql<{ registration_id: string }[]>`
    select registration_id from registration_pay_tokens where token_hash = ${hashReportToken(token)}`;
  return row?.registration_id ?? null;
}
