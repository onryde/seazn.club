import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { checkChannelSafety } from "@/server/youtube/safety-check";
import { youtubeDriver } from "@/server/youtube/driver";

type Ctx = { params: Promise<{ id: string; connectionId: string }> };

/** Phase 0 (YouTube channel safety): the facts behind the Go live notice - is the channel young, how many short broadcasts did it run
 *  lately. Org write (it is asked on a Go live tap); never key-reachable (key-scopes.ts NEVER_KEY_ROUTES). A READ: it never moves the
 *  connection, and any failure to read YouTube is 200 `warn: false`. 404 for a connection that is missing, disconnected or another
 *  organisation's - before YouTube is called. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, connectionId } = await params;
    assertUuid(id, "organization");
    assertUuid(connectionId, "youtube connection");
    const auth = await requireOrgAuth(req, id, "write");
    return checkChannelSafety(auth, id, connectionId, youtubeDriver());
  });
}
