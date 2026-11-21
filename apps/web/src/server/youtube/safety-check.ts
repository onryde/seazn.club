import "server-only";
// server/youtube/safety-check.ts — the channel-safety CHECK behind the Go live notice (Phase 0, YouTube channel safety, Task 4): read the
// connection's channel facts at YouTube and hand them to the pure `channelSafetyWarning` (channel-safety.ts).
//
// A READ, and only a read. It never moves the connection: a dead grant is NOT marked reconnect_needed here (prepare.ts's
// `markIfGrantDead` / token-store's `markReconnectNeeded` stay with the real Go live, which refuses on it), and it opens no automatic-start
// backoff. Any failure at all answers "no warning", logged as a code only, so a notice that could not be computed never stands in the
// organiser's way (a stored creation date still answers on its own). One call per Go live tap (the panel's), never from a phone beat or the automatic start: 1 quota unit each for
// channels.list (only when the creation date is not already stored) and liveBroadcasts.list.
import { sql } from "@/lib/db";
import { YOUTUBE_SAFETY_CHECK_LIMIT, YOUTUBE_SHORT_BROADCAST_WINDOW_HOURS } from "@/lib/youtube";
import { HttpError } from "@/lib/errors";
import { cacheEnabled } from "@/lib/cache";
import { rateLimit } from "@/lib/rate-limit";
import { captureError } from "@/lib/sentry";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { YoutubeChannelSafety } from "@/server/api-v1/schemas";
import { channelSafetyWarning } from "./channel-safety";
import type { YouTubePort } from "./port";
import { YouTubeError } from "./port";
import { takeSafetyRead } from "./safety-limit";
import { openToken } from "./token-store";

const NO_WARNING: YoutubeChannelSafety = { warn: false, young: false, shortRecent: 0 };

/** GET /orgs/:id/youtube-connections/:connectionId/safety. 404 for a connection that is missing, disconnected or another organisation's
 *  (one answer, before any call to YouTube). Otherwise 200: the facts, or "no warning" when they could not be read. */
export async function checkChannelSafety(
  auth: AuthCtx, orgId: string, connectionId: string, port: YouTubePort, now: Date = new Date(),
): Promise<YoutubeChannelSafety> {
  if (auth.orgId !== orgId) throw new HttpError(404, "youtube connection not found");
  const [row] = await sql<{ channel_id: string | null; channel_created_at: Date | null; status: string }[]>`
    select channel_id, channel_created_at, status from org_youtube_connections
     where id = ${connectionId} and org_id = ${orgId} and status <> 'revoked'`;
  if (!row || !row.channel_id) throw new HttpError(404, "youtube connection not found");
  // Phase 0 review I2: each read spends Seazn's shared YouTube quota, so a connection gets YOUTUBE_SAFETY_CHECK_LIMIT reads a window;
  // past it the answer is "no warning" (fail-open, as for any read that could not be made) and YouTube is not asked. Only the limit's
  // own 429 is caught: the limiter answers it and nothing else (it fails open on a Redis outage).
  // Fix round 2: with no Redis configured (prod today) that limiter lets every call through, so the in-process fallback
  // (safety-limit.ts, the same budget per connection) holds it instead.
  if (!cacheEnabled() && !takeSafetyRead(connectionId, now)) return NO_WARNING;
  try {
    await rateLimit(`yt-safety:${connectionId}`, YOUTUBE_SAFETY_CHECK_LIMIT);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return NO_WARNING;
    throw err;
  }
  // m1 (Phase 0 review): a stored creation date needs no YouTube call, so a young channel it proves still warns when the network part
  // fails; with no stored date a failure stays plain "no warning".
  const stored = row.channel_created_at;
  const fromStored = (): YoutubeChannelSafety =>
    stored === null ? NO_WARNING : channelSafetyWarning({ createdAt: stored, broadcasts: [], now });
  try {
    const refresh = await openToken(sql, orgId, connectionId);
    if (refresh === null) return fromStored();
    const at = await port.accessToken(refresh);
    const createdAt = stored ?? (await port.channelCreatedAt(at, row.channel_id));
    const since = new Date(now.getTime() - YOUTUBE_SHORT_BROADCAST_WINDOW_HOURS * 3_600_000);
    const broadcasts = await port.recentBroadcasts(at, since);
    return channelSafetyWarning({ createdAt, broadcasts, now });
  } catch (err) {
    // A code or a class name only: a port error never carries a token, but nothing else is promised of an unknown throw.
    const failure = err instanceof YouTubeError ? err.code : err instanceof Error ? err.name : "unknown";
    captureError(new Error(`youtube channel safety check failed: ${failure}`), {
      orgId, route: "youtube.safety_check", extra: { connectionId, failure },
    });
    return fromStored();
  }
}
