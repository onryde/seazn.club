import { reply, v1 } from "@/server/api-v1/http";
import { matchDayCodeOf } from "@/server/api-v1/match-day-code-door";
import { matchDayRealtimeFor } from "@/server/usecases/match-day-realtime";

/**
 * A Match Day code's realtime token (realtime push nudges, spec 2026-11-24 §3; contract
 * docs/contracts/capture-matchday-realtime.v1.json): the subscriber JWT for the code's private topic `match-day:{codeId}`, with
 * the Supabase project's public url and anon key, living min(60 minutes, the code's own expiry). Authenticated by
 * `Authorization: Bearer md_…` ONLY, resolved here (`matchDayCodeOf`): no cookie, never an API key (NEVER_KEY_ROUTES), and the
 * credential is never read from the URL. The same refusals as the day read: 401 MD_UNKNOWN, 410 MD_WITHDRAWN, 410 MD_ENDED,
 * 403 MD_NOT_OPEN (with `opens_at`), 429 RATE_LIMITED (a bucket of its own: `MD_REALTIME_LIMIT`), and a 503 REALTIME_UNAVAILABLE
 * when this server cannot serve one. No entitlement: officials producing the data. The token is a secret: `private, no-store`,
 * and in the body only. A pure read: nothing is stored.
 */
export async function GET(req: Request) {
  return v1(async () => {
    const now = new Date();
    const code = await matchDayCodeOf(req, now, "realtime");
    return reply(200, await matchDayRealtimeFor(code, now), { "cache-control": "private, no-store" });
  });
}
