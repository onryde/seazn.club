import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { PickYoutubeChannel } from "@/server/api-v1/schemas";
import { pickYoutubeChannel } from "@/server/youtube/connections";
import { youtubeDriver } from "@/server/youtube/driver";

type Ctx = { params: Promise<{ id: string }> };

/** YouTube Connect (T8): the channel pick of a multi-channel grant — the OAuth callback landed `pick` with the pending grant's
 *  id and the picker posts the chosen channel here. Org write; never key-reachable (key-scopes.ts NEVER_KEY_ROUTES: the grant is
 *  the signed-in person's own Google authorisation, and the connection's consent names them). 409 YOUTUBE_OTHER_ORG when the
 *  channel is live in another organisation (the grant is NOT revoked); 410 once the pending grant expired. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const body = await parseBody(req, PickYoutubeChannel);
    const auth = await requireOrgAuth(req, id, "write");
    return reply(201, await pickYoutubeChannel(auth, id, body, youtubeDriver()));
  });
}
