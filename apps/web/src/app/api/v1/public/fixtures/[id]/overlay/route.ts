import { v1, reply } from "@/server/api-v1/http";
import { publicRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";
import { loadOverlayLiveData } from "@/server/overlay/load";

type Ctx = { params: Promise<{ id: string }> };

/** The stream overlay's one poll target (design §3.2): the public live
 *  summary plus the two folded-state facts a scorebug needs. Visibility is
 *  the public view's (404 ≡ missing); the ENTITLEMENT gate is on the overlay
 *  PAGE, not here — this JSON is public exactly as /public/fixtures/{id} is. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { id } = await params;
    const data = await loadOverlayLiveData(id);
    return reply(200, data, { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
