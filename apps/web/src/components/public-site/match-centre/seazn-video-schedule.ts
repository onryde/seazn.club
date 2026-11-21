// Seazn-hosted video (Phase 1 Task 15; spec §5.1; recommendation 2026-11-21): WHEN the match page's island asks the video route
// again. Pure: a clock in, a delay out; the island owns the timer (seazn-video-poll.ts) and the wiring.
//
// A signed URL carries its token in the path and the token has a short life, so the island must hold a fresh URL BEFORE the one it
// plays lapses: nothing here assumes a playing Cloudflare HLS survives its token's expiry. The window is the server's own,
// `SEAZN_TOKEN_REFRESH_BEFORE_SECONDS` (the same one `cf-playback.ts` stops reusing a cached token at, so a re-read at this moment
// always gets a new token), and no read comes sooner than `SEAZN_VIDEO_POLL_FLOOR_MS` so a clock that is wrong cannot hammer the route.
import { SEAZN_TOKEN_REFRESH_BEFORE_SECONDS } from "@/server/relay/config";
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";

/** The plan's 30 s: how long a page with nothing to play waits to look again, and the least any re-read waits. */
export const SEAZN_VIDEO_POLL_FLOOR_MS = 30_000;

/** The live rule over one expiry: the refresh window ahead of it, never sooner than the floor. An expiry that is not a date has no
 *  window to compute, so it is the floor (`Math.max` would answer NaN). */
function refreshInMs(expiresAt: string, now: Date): number {
  const left = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(left)) return SEAZN_VIDEO_POLL_FLOOR_MS;
  return Math.max(SEAZN_VIDEO_POLL_FLOOR_MS, left - SEAZN_TOKEN_REFRESH_BEFORE_SECONDS * 1000);
}

/** Milliseconds until the island reads the route again, or `null` when no timer is owed.
 *   - no answer yet, or nothing to show (warming; ended with no recording signed yet): the floor;
 *   - `live`: the live token's own refresh point (the recordings listed beside it do not play, so they set no timer);
 *   - replay only: the earliest refresh point over the `hls` parts (the interim Cloudflare recording, whose token lapses like the
 *     live one); a part the replay host plays in its own iframe (`embed`, Task 25) is not on the timer, because swapping an iframe's
 *     `src` restarts it, so a replay of embeds alone owes none. That page re-reads when the viewer picks a part that has expired. */
export function nextVideoFetchMs(video: PublicFixtureVideo | null, now: Date): number | null {
  if (video === null) return SEAZN_VIDEO_POLL_FLOOR_MS;
  if (video.live !== null) return refreshInMs(video.live.expiresAt, now);
  if (video.replay.length === 0) return SEAZN_VIDEO_POLL_FLOOR_MS;
  const hls = video.replay.filter((p) => p.player === "hls");
  if (hls.length === 0) return null;
  return Math.min(...hls.map((p) => refreshInMs(p.expiresAt, now)));
}
