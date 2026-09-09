import { v1, reply } from "@/server/api-v1/http";
import { publicCompetitionHub, publicRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";

type Ctx = { params: Promise<{ orgSlug: string; slug: string }> };

/** Spectator W2 — the competition hub document the landing page polls (R10). Same
 *  JSON the page rendered from; Redis 15 s in front, deleted on every scoring write. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { orgSlug, slug } = await params;
    return reply(200, await publicCompetitionHub(orgSlug, slug), { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
