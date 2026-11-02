import { v1, reply } from "@/server/api-v1/http";
import { HttpError } from "@/lib/errors";
import { resolveLocale } from "@/lib/resolve-locale";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import { rateLimit } from "@/lib/rate-limit";
import { publicPollRateLimit } from "@/server/usecases/public";
import { DEVICE_LINK_PREFIX, resolveDeviceLinkToken } from "@/server/usecases/device-links";
import { getDeviceLinkBootstrap } from "@/server/usecases/device-link-bootstrap";

/**
 * The phone's Remote Scoring bootstrap (capture design §7.1): everything `/score/{token}`'s page resolves for a scan, as JSON.
 * Authenticated by `Authorization: Bearer dl_…` ONLY — this route resolves the link itself, so the door every other v1 route
 * keeps shut to a `dl_` token (`rejectDeviceLink`, server/api-v1/auth.ts) is not touched. A missing, malformed or non-`dl_`
 * bearer is LINK_INVALID, the same answer an unknown link gets; revoked and expired are their own codes, as the resolver says.
 * Metered twice, with the helpers the neighbouring doors use: per IP BEFORE the link is resolved (`publicPollRateLimit`, the
 * bucket for what a page polls on a timer: a waiting phone re-reads this), so a flood of guessed tokens costs the prober before
 * any database read; then per link AFTER (`dlv1-read:`, the 10/s budget the dl_ door in auth.ts gives a scorer). Both answer 429
 * RATE_LIMITED with Retry-After in the v1 envelope. Read-only, and never cached: a waiting phone polls it and the screen it names moves with the organiser's Start.
 */
export async function GET(req: Request) {
  return v1(async () => {
    const header = req.headers.get("authorization");
    await publicPollRateLimit(req);
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token.startsWith(DEVICE_LINK_PREFIX)) throw new HttpError(401, "Invalid device link", "LINK_INVALID");
    const link = await resolveDeviceLinkToken(token);
    await rateLimit(`dlv1-read:${link.id}`, { max: 10, windowSeconds: 1 });
    const locale = await resolveLocale();
    const lookup = (k: MessageKey, v?: Record<string, string | number>) => msgFor(locale, k, v);
    return reply(200, await getDeviceLinkBootstrap(link, lookup), { "cache-control": "no-store" });
  });
}
