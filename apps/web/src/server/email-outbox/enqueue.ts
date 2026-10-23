import "server-only";
// Writing an outbox row (spec "Sending"): `enqueueEmail(db, message)` inserts on the handle it is given, so a caller
// inside `withTenant` / `sql.begin` queues the email in the SAME transaction as the thing that caused it (committed <=>
// queued; a rollback queues nothing). It never calls Resend; `dispatchNow` does, after the caller commits.
//
// Two constraints from the schema (V469):
//  - `app_user` holds INSERT only, so the id is made here and the insert has no RETURNING (RETURNING needs SELECT);
//  - the replace trigger supersedes older non-terminal rows for the same kind + ref + recipient on this very insert.
import { randomUUID } from "node:crypto";
import type { Tx, sql } from "@/lib/db";
import type { OutboxKind } from "./constants";
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
  /** After this the email is worthless; the row ends `expired`, unsent. */
  expiresAt: Date;
  /** Non-secret data a kind's hooks need later (ids, stamps). Never a token, never a body. */
  meta?: Record<string, string>;
};

/**
 * Insert one queued row on `db` and return its id (client-made). Throws `OutboxKeyUnavailableError` BEFORE any
 * statement when the box can send mail but cannot seal the body, so the caller's transaction refuses as a whole.
 */
export async function enqueueEmail(db: Tx | typeof sql, m: OutboxMessage): Promise<string> {
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
