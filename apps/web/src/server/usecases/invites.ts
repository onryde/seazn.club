import "server-only";
import crypto from "node:crypto";
import { sql, type Tx } from "@/lib/db";
import type { OrgInvite } from "@/lib/types";

/** No explicit expiry asked for → the courtside-QR default: one hour. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** Email invites must survive an inbox: a week to accept. */
export const EMAIL_INVITE_TTL_DAYS = 7;

/** An invite as it is STORED: the token is always there. Server-side only: what an org editor is shown is
 *  `inviteForEditor` of it. */
export type StoredInvite = Omit<OrgInvite, "token"> & { token: string };

/**
 * What an org editor may see of an invite: every editor-facing answer (the list, the create answer) goes through
 * here. The token of an EMAIL-bound invite is a one-click sign-in for a new or unverified account at that address
 * (`claimEmailInvite`, lib/invites.ts), sound only because the token reaches that mailbox and nobody else. So it is
 * nulled: an editor who could read it could invite an address they do not own and claim it themselves. A
 * shareable link keeps its token (copying it is the point). "Email-bound" is a non-empty `email`, the same test
 * `claimEmailInvite` and `acceptInvite` apply.
 */
export function inviteForEditor(invite: StoredInvite): OrgInvite {
  return { ...invite, token: invite.email ? null : invite.token };
}

export interface CreateInviteInput {
  role: "admin" | "viewer";
  max_uses: number;
  expires_in_days?: number | null;
  email?: string | null;
}

/**
 * Create an org invite. Two shapes share this path:
 *  - shareable links (team settings, courtside QR): expires_in_days picks the
 *    lifetime — undefined keeps the legacy one-hour TTL, null never expires;
 *  - email invites (`email` set): personal, forced single-use, 7-day expiry.
 * `db` is the handle the insert runs on: the org's invite route passes its transaction, so an email invite and the outbox row that
 * mails its link commit together. Returns the STORED invite, token included (the route builds the email from it); a
 * caller answering an editor passes it through `inviteForEditor` first.
 */
export async function createInvite(
  orgId: string,
  createdBy: string,
  input: CreateInviteInput,
  db: Tx | typeof sql = sql,
): Promise<StoredInvite> {
  const email = input.email?.trim().toLowerCase() || null;
  const maxUses = email ? 1 : input.max_uses;
  const days = email ? EMAIL_INVITE_TTL_DAYS : input.expires_in_days;
  let expiresAt: string | null;
  if (days === undefined) {
    expiresAt = new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
  } else if (days === null) {
    expiresAt = null;
  } else {
    expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  }

  const token = crypto.randomBytes(24).toString("base64url");
  const [invite] = await db<StoredInvite[]>`
    insert into org_invites
      (org_id, role, email, token, created_by, expires_at, max_uses)
    values
      (${orgId}, ${input.role}, ${email}, ${token}, ${createdBy}, ${expiresAt}, ${maxUses})
    returning id, org_id, role, email, token, expires_at, max_uses,
              used_count, revoked, created_at`;
  return invite;
}
