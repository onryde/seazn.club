import { v1, reply } from "@/server/api-v1/http";
import { publicCompetitionHub, publicPollRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";
import { hubDocEtag } from "@/lib/hub-doc-etag";

type Ctx = { params: Promise<{ orgSlug: string; slug: string }> };

/** Spectator W2 — the competition hub document the landing page polls (R10). Same
 *  JSON the page rendered from; Redis 15 s in front, deleted on every scoring write.
 *
 *  W5 follow-ups B4: every answer names the document's build (`ETag`, `hubDocEtag`), and a poll that already holds that
 *  build (`If-None-Match`) is answered 304 with no body - the page polls every 15 s, and at a cap-sized competition the
 *  document is about 5 MB, so a tick that changes nothing now costs headers only. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicPollRateLimit(req);
    const { orgSlug, slug } = await params;
    const doc = await publicCompetitionHub(orgSlug, slug);
    const etag = hubDocEtag(doc);
    const headers = { "Cache-Control": PUBLIC_CACHE_CONTROL, ETag: etag };
    if (req.headers.get("If-None-Match") === etag) return reply(304, null, headers);
    return reply(200, doc, headers);
  });
}
