import { v1, reply } from "@/server/api-v1/http";
import { publicPollRateLimit } from "@/server/usecases/public";
import { loadOverlayLiveData } from "@/server/overlay/load";
import { relayPageAccess, relayParamsOf, type RelayPageAccess } from "@/server/overlay/relay-access";
import { log } from "@/server/logger";

type Ctx = { params: Promise<{ id: string }> };

/** Live overlay JSON. Review 2026-09-14 (I9, twin of the fixture summary
 *  route's fix): this used to be `private, no-store`, which fixed OBS/browser
 *  polls reusing the pre-ball body but also killed CDN collapsing on this
 *  high-traffic poll target. The browser-staleness bug is fixed client-side —
 *  `fetchOverlayFixture` (`live-score-data.ts`) already sends
 *  `{cache: "no-store"}` — so the edge can hold a short PUBLIC, collapsible
 *  window instead: 2s bounds staleness well under the old 30s. */
const LIVE_CACHE_CONTROL = "public, s-maxage=2, stale-while-revalidate=30";

/** R2005 change 6 (fallback B): the relay answer names one session's programme phase and may carry a fixture that is
 *  not public, so no shared cache may hold it — never the edge's collapsing window above. */
const RELAY_CACHE_CONTROL = "private, no-store";

/** One value per name, or none: a repeated `sid` / `st` is not a relay request (`relayParamsOf`'s rule). */
function single(url: URL, name: string): string | undefined {
  const all = url.searchParams.getAll(name);
  return all.length === 1 ? all[0] : undefined;
}

/** The relay access for this poll, or null. Unlike the PAGE (where a refusal is the opaque 404), every failure here —
 *  a refusal, and an error while checking — falls through to the public answer EXACTLY: the overlay must not go dark
 *  over its phase channel's fallback, and a bad token learns nothing it could not learn without one. */
async function relayAccessOf(req: Request, id: string): Promise<RelayPageAccess | null> {
  const url = new URL(req.url);
  const params = relayParamsOf({ sid: single(url, "sid"), st: single(url, "st") });
  if (!params) return null;
  try {
    return await relayPageAccess(id, params);
  } catch (err) {
    log.error({ err, fixtureId: id }, "overlay: relay access check failed, serving the public answer");
    return null;
  }
}

/** The stream overlay's one poll target (design §3.2): the public live
 *  summary plus the two folded-state facts a scorebug needs. Visibility is
 *  the public view's (404 ≡ missing); the ENTITLEMENT gate is on the overlay
 *  PAGE, not here — this JSON is public exactly as /public/fixtures/{id} is. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicPollRateLimit(req);
    const { id } = await params;
    // R2005: a verified composed session's compositor (sid + st, `relay-access.ts`) reads through the bypass and gets
    // the phase its last stored beat carried (fallback B, compositor spec §4.3) — absent when the beat had none.
    const access = await relayAccessOf(req, id);
    if (access) {
      const data = await loadOverlayLiveData(id, { relay: true });
      const body = access.programmePhase ? { ...data, programmePhase: access.programmePhase } : data;
      return reply(200, body, { "Cache-Control": RELAY_CACHE_CONTROL });
    }
    const data = await loadOverlayLiveData(id);
    return reply(200, data, { "Cache-Control": LIVE_CACHE_CONTROL });
  });
}
