import { v1, reply } from "@/server/api-v1/http";
import { publicFixture, publicRateLimit } from "@/server/usecases/public";

type Ctx = { params: Promise<{ id: string }> };

/** Live public fixture summary (doc 08 §3). Review 2026-09-14 (I9): this used
 *  to be `private, no-store`, which fixed the stale-body symptom but also
 *  killed CDN request collapsing on the highest-traffic public poll endpoint.
 *  The actual browser-staleness bug is fixed client-side instead —
 *  `fetchLiveFixture` (`live-score-data.ts`) already sends
 *  `{cache: "no-store"}` on every poll — so the edge can go back to a short
 *  PUBLIC, collapsible window: 2s bounds staleness well under the old 30s,
 *  `stale-while-revalidate` keeps a burst of polls off the origin. */
const LIVE_CACHE_CONTROL = "public, s-maxage=2, stale-while-revalidate=30";

/** Live public fixture summary (doc 08 §3). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { id } = await params;
    const data = await publicFixture(id);
    return reply(200, data, { "Cache-Control": LIVE_CACHE_CONTROL });
  });
}
