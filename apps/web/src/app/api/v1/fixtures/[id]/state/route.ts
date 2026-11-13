import { v1, reply } from "@/server/api-v1/http";
import { requireFixtureActor } from "@/server/api-v1/auth";
import { fixtureStateEtag, getFixtureState } from "@/server/usecases/fixtures";
import { withQuickMatchFinished } from "@/server/usecases/quick-match-skip";

type Ctx = { params: Promise<{ id: string }> };

/** Live state (summary + fold + status). ETag = a digest of this body
 *  (`fixtureStateEtag`), so a change that appends no event still moves it.
 *  A quick match's Not played match also says whether its league has
 *  finished (`quick_match_finished`, FR4 m2): its guest pad stops waiting for
 *  a Put back then. Every other body is the one it always was. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  let etag: string | undefined;
  const res = await v1(async () => {
    const auth = await requireFixtureActor(req, id, "read");
    const state = await withQuickMatchFinished(auth.orgId, await getFixtureState(auth, id));
    etag = fixtureStateEtag(state);
    return reply(200, state, { ETag: etag });
  });
  if (etag && req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return res;
}
