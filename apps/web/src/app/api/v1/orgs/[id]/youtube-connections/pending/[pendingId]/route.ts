import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { pendingChannels } from "@/server/youtube/connections";

type Ctx = { params: Promise<{ id: string; pendingId: string }> };

/** YouTube Connect (T8): the channels a pending grant offers, for the picker. Only the person who made the grant, in the org it
 *  was made for, while it lives. It is a step of the connect write, so it takes the connect's role (org write), not the read one.
 *  Never key-reachable (key-scopes.ts NEVER_KEY_ROUTES). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, pendingId } = await params;
    assertUuid(id, "organization");
    assertUuid(pendingId, "connect request");
    const auth = await requireOrgAuth(req, id, "write");
    return pendingChannels(auth, id, pendingId);
  });
}
