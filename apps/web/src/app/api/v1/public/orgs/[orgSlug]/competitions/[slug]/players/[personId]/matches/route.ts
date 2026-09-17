import { v1, reply } from "@/server/api-v1/http";
import { publicPlayerMatches, publicPollRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";

type Ctx = { params: Promise<{ orgSlug: string; slug: string; personId: string }> };

/** Spectator W2, Task 14 — the player page's match lines, polled while the page is
 *  open (R10). Same lines the page rendered from; Redis 15 s in front. 404 for a
 *  private competition and for any person whose public page would 404. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicPollRateLimit(req);
    const { orgSlug, slug, personId } = await params;
    return reply(200, await publicPlayerMatches(orgSlug, slug, personId), { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
