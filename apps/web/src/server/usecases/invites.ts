import "server-only";
import crypto from "node:crypto";
import { sql } from "@/lib/db";
import type { OrgInvite } from "@/lib/types";

/** No explicit expiry asked for → the courtside-QR default: one hour. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** Email invites must survive an inbox: a week to accept. */
export const EMAIL_INVITE_TTL_DAYS = 7;

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
 */
export async function createInvite(
  orgId: string,
  createdBy: string,
  input: CreateInviteInput,
): Promise<OrgInvite> {
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
  const [invite] = await sql<OrgInvite[]>`
    insert into org_invites
      (org_id, role, email, token, created_by, expires_at, max_uses)
    values
      (${orgId}, ${input.role}, ${email}, ${token}, ${createdBy}, ${expiresAt}, ${maxUses})
    returning id, org_id, role, email, token, expires_at, max_uses,
              used_count, revoked, created_at`;
  return invite;
}
