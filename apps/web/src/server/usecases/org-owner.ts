import "server-only";
// The one owner lookup for owner-addressed mail (phase 3 wave 2). A deliberate LEAF: it imports only `@/lib/db`, so the registration,
// sponsor and billing modules can all import it without the circular import that kept each of them on a private copy of this query
// (sponsors.ts's `currentOrgOwnerEmail` says why it could not import billing-events'). The copies also disagreed: two read
// `limit 1` with no order, so an org with two owners was mailed whichever row the planner met first.
import type { Tx, sql } from "@/lib/db";

/**
 * The organisation's current owner, as the account an owner-addressed notice is queued to (`recipientUserId`) and its address at the
 * time (`email`): the OLDEST owner membership (owner ruling Q2, 2026-10-26; ties go to the lower user id, so the answer never depends on
 * row order), never `organizations.created_by` (an ownership transfer flips the role and leaves `created_by` on the old owner), and never
 * a deleted account. `null` when the org has no such owner; the caller then has no one to tell.
 *
 * Reads on the handle it is given. Inside a tenant transaction pass the `tx`: a pooled read there would hold a second connection while
 * the first waits for it (#996).
 */
export async function orgOwnerRecipient(db: Tx | typeof sql, orgId: string): Promise<{ userId: string; email: string } | null> {
  const [owner] = await db<{ user_id: string; email: string }[]>`
    select m.user_id, u.email
      from org_members m
      join users u on u.id = m.user_id and u.deleted_at is null
     where m.org_id = ${orgId} and m.role = 'owner'
     order by m.created_at, m.user_id
     limit 1`;
  return owner ? { userId: owner.user_id, email: owner.email } : null;
}
