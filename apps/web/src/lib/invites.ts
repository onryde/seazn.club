import "server-only";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { OrgRole } from "@/lib/types";

export interface InviteRow {
  id: string;
  org_id: string;
  org_name: string;
  role: OrgRole;
  /** Invite-by-email: personal — only the account with this address may
   *  accept (enforced in acceptInvite). Null for shareable links. */
  email: string | null;
  expires_at: string | null;
  max_uses: number;
  used_count: number;
  revoked: boolean;
}

/** Load an invite by token, joined with its org name. */
export async function loadInvite(token: string): Promise<InviteRow | null> {
  const rows = await sql<InviteRow[]>`
    select i.id, i.org_id, o.name as org_name, i.role,
           i.email, i.expires_at, i.max_uses, i.used_count, i.revoked
    from org_invites i
    join organizations o on o.id = i.org_id
    where i.token = ${token} limit 1`;
  return rows[0] ?? null;
}

/** Stable reason an invite cannot be used (locale-agnostic), or null when valid.
 *  UI surfaces map the code to localized copy (`join.problem.<code>` in `ui`);
 *  API routes render it in English via inviteProblem(). */
export type InviteProblem = "revoked" | "expired" | "used";

const INVITE_PROBLEM_EN: Record<InviteProblem, string> = {
  revoked: "This invite has been revoked",
  expired: "This invite has expired",
  used: "This invite has already been used",
};

export function inviteProblemCode(invite: InviteRow): InviteProblem | null {
  if (invite.revoked) return "revoked";
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now())
    return "expired";
  if (invite.max_uses !== 0 && invite.used_count >= invite.max_uses) return "used";
  return null;
}

/** English reason string for API responses (programmatic, not user-facing UI). */
export function inviteProblem(invite: InviteRow): string | null {
  const code = inviteProblemCode(invite);
  return code ? INVITE_PROBLEM_EN[code] : null;
}

/**
 * Membership grant for an accepted invite: seat quota counted in the same tx
 * as the insert. No-op when already a member.
 */
export async function grantInvite(invite: InviteRow, userId: string): Promise<void> {
  const { getLimit } = await import("@/lib/entitlements");
  const { PaymentRequiredError } = await import("@/lib/errors");
  const quotaKey = "members.max";
  const limit = await getLimit(invite.org_id, quotaKey);
  await sql.begin(async (tx) => {
    await tx`select 1 from organizations where id = ${invite.org_id} for update`;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from org_members where org_id = ${invite.org_id}`;
    if (limit !== null && n + 1 > limit) throw new PaymentRequiredError(quotaKey);
    await tx`
      insert into org_members (org_id, user_id, role)
      values (${invite.org_id}, ${userId}, ${invite.role})
      on conflict (org_id, user_id) do nothing`;
    await tx`
      update org_invites set used_count = used_count + 1
      where id = ${invite.id}`;
  });
  const { invalidateUserOrgs } = await import("@/lib/auth");
  await invalidateUserOrgs(userId);
}

export type AcceptOutcome = "joined" | "already_member";

/**
 * Accept an invite for a (possibly already-member) user. Invites are
 * additive and never change an existing role:
 *  - not a member → grantInvite (join with the invite's role);
 *  - already a member → no-op, and the use is NOT burnt.
 */
export async function acceptInvite(invite: InviteRow, userId: string): Promise<AcceptOutcome> {
  if (invite.email) {
    const [u] = await sql<{ email: string }[]>`
      select email from users where id = ${userId}`;
    if (!u || u.email.toLowerCase() !== invite.email.toLowerCase()) {
      throw new HttpError(403, "This invite was sent to a different email address");
    }
  }
  const { getOrgRole } = await import("@/lib/auth");
  const existing = await getOrgRole(invite.org_id, userId);
  if (!existing) {
    await grantInvite(invite, userId);
    return "joined";
  }
  return "already_member";
}

/** Post-accept landing: everyone goes to the dashboard. */
export function inviteLanding(_role: OrgRole, _outcome: AcceptOutcome): string {
  return "/dashboard";
}

export type ClaimResult =
  | { needs_signin: true }
  | {
      needs_signin: false;
      user_id: string;
      org_id: string;
      org_name: string;
      role: OrgRole;
      outcome: AcceptOutcome;
    };

/**
 * DB core of the one-click email-invite accept (POST /api/invites/[token]/claim).
 * For an invitee whose account is NEW or UNVERIFIED it resolves/creates the
 * account, joins the org, and marks the address verified — the caller then mints
 * the session cookie. A VERIFIED account is refused (`needs_signin`) so a
 * forwarded invite can never take over a real account; the caller falls back to
 * normal sign-in. Shareable links (no bound email) are likewise not claimable
 * this way. Throws (HttpError) for a missing/expired/revoked/used invite — no
 * account is created in that case.
 */
export async function claimEmailInvite(token: string): Promise<ClaimResult> {
  const invite = await loadInvite(token);
  if (!invite) throw new HttpError(404, "Invite not found");
  const problem = inviteProblem(invite);
  if (problem) throw new HttpError(400, problem);
  if (!invite.email) return { needs_signin: true };

  const [account] = await sql<{ id: string; email_verified: boolean }[]>`
    select id, email_verified from users
    where email = ${invite.email} and deleted_at is null limit 1`;
  if (account?.email_verified) return { needs_signin: true };

  const { resolveOrCreateUser } = await import("@/lib/users");
  const userId = account?.id ?? (await resolveOrCreateUser(invite.email));
  if (!userId) throw new HttpError(500, "Could not resolve the invited account");

  const outcome = await acceptInvite(invite, userId);
  await sql`update users set email_verified = true where id = ${userId}`;

  const { getOrgRole } = await import("@/lib/auth");
  const role = (await getOrgRole(invite.org_id, userId)) ?? invite.role;
  return {
    needs_signin: false,
    user_id: userId,
    org_id: invite.org_id,
    org_name: invite.org_name,
    role,
    outcome,
  };
}
