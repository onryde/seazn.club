import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { YoutubeConnectionSettings } from "@/server/api-v1/schemas";
import { updateConnectionSettings } from "@/server/youtube/connections";
import { disconnectYoutube } from "@/server/youtube/disconnect";
import { youtubeDriver } from "@/server/youtube/driver";

type Ctx = { params: Promise<{ id: string; connectionId: string }> };

/** YouTube Connect (T8): a connection's settings — default visibility, made-for-kids, and the consent on the current wording
 *  ("Review updated terms"). Org write; never key-reachable (key-scopes.ts NEVER_KEY_ROUTES: a consent names the person who gave
 *  it). Disconnect (DELETE) lands in T18. */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, connectionId } = await params;
    assertUuid(id, "organization");
    assertUuid(connectionId, "youtube connection");
    const body = await parseBody(req, YoutubeConnectionSettings);
    const auth = await requireOrgAuth(req, id, "write");
    return updateConnectionSettings(auth, id, connectionId, body);
  });
}

/** YouTube Connect (T18): Disconnect - revoke the grant at Google, purge what Seazn stored from YouTube, archive the destination.
 *  Org write (owner or admin); never key-reachable (the channel is the signed-in person's own authorisation). Deliberately NOT behind
 *  the streaming entitlement: a club that lost the plan must still be able to take its channel back. 409 YOUTUBE_IN_USE while a match
 *  is using the channel; 404 for a connection that is missing, already disconnected or another organisation's (one answer). */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, connectionId } = await params;
    assertUuid(id, "organization");
    assertUuid(connectionId, "youtube connection");
    const auth = await requireOrgAuth(req, id, "write");
    return disconnectYoutube(auth, id, connectionId, youtubeDriver());
  });
}
