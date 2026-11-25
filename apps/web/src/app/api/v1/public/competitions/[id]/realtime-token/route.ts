import { reply, v1 } from "@/server/api-v1/http";
import { getCurrentUser } from "@/lib/auth";
import { publicRealtimeTokenRateLimit } from "@/server/usecases/public";
import { competitionRealtimeFor } from "@/server/public-site/division-realtime";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A competition's realtime token (realtime push nudges, spec 2026-11-24 §4.1, plan Task 12): `{token, divisionIds,
 * expiresAt, url, apikey}`, the subscriber JWT for the competition's private `division:{id}` topics, living 60 minutes
 * (`expiresAt` in epoch SECONDS, the token's own `exp`). The hub, the slideshow and the board ask once per subscription and
 * again before it lapses — never on a timer — so it spends a per-IP bucket of its own (`pubv1rt`, 120 a minute), never the
 * 60 of the other public reads nor the poll bucket.
 *
 * Officials (any org role, or an accepted official on a fixture of the competition) are served every division of any
 * competition; spectators every division of a public or unlisted one whose org holds `realtime`
 * (server/public-site/division-realtime.ts). 404 for a competition the caller may not see, 403 when realtime is not theirs
 * here or the competition has no division (`no_divisions`) or more than 100 (`too_many_divisions`), 429 RATE_LIMITED, 503
 * REALTIME_UNAVAILABLE when this server cannot serve one. Any refusal means the page keeps polling.
 *
 * The token is a secret: `private, no-store`, in the body only, never in the hub document or the page's HTML. A pure read:
 * nothing is stored, and every call mints a fresh token.
 */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRealtimeTokenRateLimit(req);
    const { id } = await params;
    const user = await getCurrentUser();
    const answer = await competitionRealtimeFor(id, user?.id ?? null, new Date());
    return reply(200, answer, { "cache-control": "private, no-store" });
  });
}
