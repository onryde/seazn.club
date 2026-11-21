import { v1, reply } from "@/server/api-v1/http";
import { publicRateLimit } from "@/server/usecases/public";
import { seaznFixtureVideo } from "@/server/video/seazn-video";

type Ctx = { params: Promise<{ id: string }> };

/** The body holds signed playback URLs (their token is a path segment): never stored by the edge or the browser, which would
 *  serve one past its token's life — and, at the edge, to someone else. */
const VIDEO_CACHE_CONTROL = "private, no-store";

/** Seazn-hosted video (Task 14): a fixture's Seazn live and replay parts, signed for this viewer's player
 *  (server/video/seazn-video.ts). A fixture the public cannot see answers `{ live: null, replay: [] }`, like one with no video.
 *  The public per-IP limit, as its sibling realtime-token, spent before anything is read or signed. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { id } = await params;
    return reply(200, await seaznFixtureVideo(id, new Date()), { "Cache-Control": VIDEO_CACHE_CONTROL });
  });
}
