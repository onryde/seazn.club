import { v1, reply } from "@/server/api-v1/http";
import { publicRateLimit } from "@/server/usecases/public";
import { loadOverlayLiveData } from "@/server/overlay/load";

type Ctx = { params: Promise<{ id: string }> };

/** Live overlay JSON — never CDN/browser-cached. `PUBLIC_CACHE_CONTROL`
 *  (s-maxage=30) is correct for static public pages; on this route it made
 *  OBS/browser polls reuse the pre-ball body while the match moved on. */
const LIVE_CACHE_CONTROL = "private, no-store";

/** The stream overlay's one poll target (design §3.2): the public live
 *  summary plus the two folded-state facts a scorebug needs. Visibility is
 *  the public view's (404 ≡ missing); the ENTITLEMENT gate is on the overlay
 *  PAGE, not here — this JSON is public exactly as /public/fixtures/{id} is. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { id } = await params;
    const data = await loadOverlayLiveData(id);
    return reply(200, data, { "Cache-Control": LIVE_CACHE_CONTROL });
  });
}
