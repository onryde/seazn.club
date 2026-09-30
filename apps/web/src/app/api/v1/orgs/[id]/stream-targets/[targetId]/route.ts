import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { PatchStreamTarget } from "@/server/api-v1/schemas";
import { patchStreamTarget, removeStreamTarget } from "@/server/usecases/stream-targets";
import { defaultDeps, expireTargetHolders } from "@/server/usecases/stream-sessions";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string; targetId: string }> };

/** Spec §5.2 — Rename / Replace key. Org write, never key-reachable (key-scopes.ts NEVER_KEY_ROUTES: a target carries
 *  a stream key). A Replace first ticks the holders' expiry so a stuck session does not refuse it. */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, targetId } = await params;
    assertUuid(id, "organization");
    assertUuid(targetId, "stream target");
    const body = await parseBody(req, PatchStreamTarget);
    const auth = await requireOrgAuth(req, id, "write");
    if (body.streamKey !== undefined && auth.orgId === id) await expireTargetHolders(id, targetId, defaultDeps(baseUrl(req)));
    return patchStreamTarget(auth, id, targetId, body);
  });
}

/** Spec §5.2 — Remove = archive (D2). 409 TARGET_IN_USE while held; 404 once archived. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, targetId } = await params;
    assertUuid(id, "organization");
    assertUuid(targetId, "stream target");
    const auth = await requireOrgAuth(req, id, "write");
    if (auth.orgId === id) await expireTargetHolders(id, targetId, defaultDeps(baseUrl(req)));
    return removeStreamTarget(auth, id, targetId);
  });
}
