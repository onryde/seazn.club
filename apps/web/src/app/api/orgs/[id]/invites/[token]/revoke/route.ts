import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { EDITOR_ROLES } from "@/lib/types";

/** The canonical uuid shape, exactly what `org_invites.id` prints as. A join token (24 random bytes, base64url: 32
 *  characters, no hyphens at fixed places) can never take it, so the two forms cannot collide, and a ref that is not
 *  this shape is never cast to uuid (Postgres would answer 22P02, a 500). */
const INVITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Revoke an invite so it can no longer be used (editors only).
 *
 *  The path segment is the invite's ID: what the Team panel sends, and the only handle an editor has on an
 *  EMAIL-bound invite, whose token never leaves the invitee's email (`inviteForEditor`). A shareable link's token is
 *  still accepted in its place, for API callers that predate ids. Scoped to the org either way: another org's id or
 *  token matches nothing. The answer is the same whether anything matched, so it confirms no token. (The directory
 *  keeps its `[token]` name: the path-secret scrubbers key on it, and an id there is scrubbed harmlessly.) */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; token: string }> },
) {
  return handler(async () => {
    const { id, token: ref } = await params;
    await requireOrgRole(id, EDITOR_ROLES);
    await sql`
      update org_invites set revoked = true
      where org_id = ${id}
        and ${INVITE_ID.test(ref) ? sql`id = ${ref}::uuid` : sql`token = ${ref}`}`;
    return { ok: true };
  });
}
