import { v1, reply } from "@/server/api-v1/http";
import { publicCompetitionHub, publicPollRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";
import { hubDocEtag } from "@/server/public-site/hub-doc-etag";
import { HUB_BUILD_HEADER } from "@/lib/hub-doc-stamp";
import { HUB_WINDOW_PARAM, HUB_WINDOW_ROUNDS, windowHubDoc } from "@/lib/hub-round-paging";

type Ctx = { params: Promise<{ orgSlug: string; slug: string }> };

/** Spectator W2 — the competition hub document the landing page polls (R10). Same
 *  JSON the page rendered from; Redis 15 s in front, deleted on every scoring write.
 *
 *  W5 follow-ups B4: every answer names the document's content (`ETag`, `hubDocEtag`: a hash of all but `generatedAt`), and
 *  a poll that already holds that content (`If-None-Match`) is answered 304 with no body - the page polls every 15 s, and at a cap-sized competition the
 *  document is about 5 MB, so a tick that changes nothing now costs headers only. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicPollRateLimit(req);
    const { orgSlug, slug } = await params;
    // W5 follow-ups C, review I3 (controller ruling): a public API answers EVERY match, as before the paging. Only the page's own poll
    // (`fetchCompetitionHub`) asks for the page's window (`?window=rounds`, `windowHubDoc`: a big division's folded rounds as
    // `roundPages` headers); anything else is the complete document.
    const full = await publicCompetitionHub(orgSlug, slug);
    const doc = new URL(req.url).searchParams.get(HUB_WINDOW_PARAM) === HUB_WINDOW_ROUNDS ? windowHubDoc(full) : full;
    const etag = hubDocEtag(doc);
    // The build a 304 confirms: the page re-stamps the document it holds with it (`restampHubDoc`).
    const headers = { "Cache-Control": PUBLIC_CACHE_CONTROL, ETag: etag, [HUB_BUILD_HEADER]: doc.generatedAt };
    if (req.headers.get("If-None-Match") === etag) return reply(304, null, headers);
    return reply(200, doc, headers);
  });
}
