import { v1, reply } from "@/server/api-v1/http";
import { requireFixtureActor } from "@/server/api-v1/auth";
import { fixtureStateEtag, getFixtureState } from "@/server/usecases/fixtures";

type Ctx = { params: Promise<{ id: string }> };

/** Live state (summary + fold + status). ETag = a digest of this body
 *  (`fixtureStateEtag`), so a change that appends no event still moves it. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  let etag: string | undefined;
  const res = await v1(async () => {
    const auth = await requireFixtureActor(req, id, "read");
    const state = await getFixtureState(auth, id);
    etag = fixtureStateEtag(state);
    return reply(200, state, { ETag: etag });
  });
  if (etag && req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return res;
}
