import { v1, reply } from "@/server/api-v1/http";
import { publicOrgLive, publicPollRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";

type Ctx = { params: Promise<{ orgSlug: string }> };

/** Spectator W2, Task 15 — what the org home's chip island polls (R10): every
 *  competition the org home lists, with its status and in-play count. Redis
 *  15 s in front, deleted on every scoring write. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicPollRateLimit(req);
    const { orgSlug } = await params;
    return reply(200, await publicOrgLive(orgSlug), { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
