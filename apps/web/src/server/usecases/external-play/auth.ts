import "server-only";
// Privileged, session-less auth for cron/guard-shaped code paths that must
// act as an org's owner with no real HTTP session (mint/sync/whiteSideOf's
// getFixtureState read). Moved verbatim from the pre-redesign
// usecases/external-play.ts (chess Lichess external-play redesign, Task 7).
//
// Ruling R2 (controller, 2026-09-16): this is its PERMANENT home — later
// tasks (9: sync, 10: sweep) import it from here rather than re-defining or
// relocating it. `index.ts` re-exports it.
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";

export async function mintOrgOwnerAuth(orgId: string): Promise<AuthCtx> {
  const [owner] = await sql<{ user_id: string }[]>`
    select user_id from org_members
     where org_id = ${orgId} and role = 'owner'
     order by created_at asc
     limit 1`;
  if (!owner) {
    throw new Error(`no owner for org ${orgId}`);
  }
  return {
    orgId,
    via: "session",
    userId: owner.user_id,
    role: "owner",
    keyId: null,
  };
}
