import { v1 } from "@/server/api-v1/http";
import { NOT_A_MEMBER, requireResourceAuth, resourceOrg } from "@/server/api-v1/auth";
import { AuthError, HttpError } from "@/lib/errors";
import { seaznFixtureVideoForOrg } from "@/server/video/seazn-video";

type Ctx = { params: Promise<{ id: string }> };

/** The ORGANISER's Seazn video of a fixture (Seazn-hosted video, Task 17): what Match Day's stream preview plays
 *  (`<SeaznVideoIsland endpoint="org">`). The same body as the public route (`PublicFixtureVideo`: `live`, and the finished
 *  recordings as `replay`, each a signed playback address), read for this organisation's own fixture whatever its competition's
 *  visibility, so a private competition's live plays for the organiser who is running it.
 *
 *  Any member of the fixture's organisation reads it (the door's `read` scope: a viewer opens Match Day too); never key-reachable
 *  (NEVER_KEY_ROUTES), because a signed address is a bearer credential. A signed-in user who is NOT a member, an id that names
 *  nothing and one that is not a uuid all answer the same 404 — the answer is no oracle for which fixtures exist — and nothing is
 *  signed for them: the read is reached only past the door. Signed out stays 401.
 *
 *  EVERY answer is `private, no-store` and varies on both credentials the door reads (the stream-phone read's shape): the body holds
 *  signed addresses, and a copy kept past their token's life, or served to someone else, is the leak. */
export async function GET(req: Request, { params }: Ctx) {
  const res = await v1(async () => {
    const { id } = await params;
    // 404 for a malformed id and an unknown one (`resourceOrg`); `requireResourceAuth` resolves the org once more and runs the door.
    await resourceOrg("fixture", id);
    let auth;
    try {
      auth = await requireResourceAuth(req, "fixture", id, "read");
    } catch (err) {
      if (err instanceof AuthError && err.message === NOT_A_MEMBER) throw new HttpError(404, "fixture not found");
      throw err;
    }
    return seaznFixtureVideoForOrg(auth.orgId, id, new Date());
  });
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Cookie, Authorization");
  return res;
}
