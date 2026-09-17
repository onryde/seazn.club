import { v1, reply } from "@/server/api-v1/http";
import { publicPollRateLimit } from "@/server/usecases/public";
import { loadOverlayLiveData } from "@/server/overlay/load";

type Ctx = { params: Promise<{ id: string }> };

/** Live overlay JSON. Review 2026-09-14 (I9, twin of the fixture summary
 *  route's fix): this used to be `private, no-store`, which fixed OBS/browser
 *  polls reusing the pre-ball body but also killed CDN collapsing on this
 *  high-traffic poll target. The browser-staleness bug is fixed client-side —
 *  `fetchOverlayFixture` (`live-score-data.ts`) already sends
 *  `{cache: "no-store"}` — so the edge can hold a short PUBLIC, collapsible
 *  window instead: 2s bounds staleness well under the old 30s. */
const LIVE_CACHE_CONTROL = "public, s-maxage=2, stale-while-revalidate=30";

/** The stream overlay's one poll target (design §3.2): the public live
 *  summary plus the two folded-state facts a scorebug needs. Visibility is
 *  the public view's (404 ≡ missing); the ENTITLEMENT gate is on the overlay
 *  PAGE, not here — this JSON is public exactly as /public/fixtures/{id} is. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicPollRateLimit(req);
    const { id } = await params;
    const data = await loadOverlayLiveData(id);
    return reply(200, data, { "Cache-Control": LIVE_CACHE_CONTROL });
  });
}
