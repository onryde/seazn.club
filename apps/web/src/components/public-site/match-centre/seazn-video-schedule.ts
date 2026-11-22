// Seazn-hosted video (Phase 1 Task 15; spec §5.1; recommendation 2026-11-21): WHEN the match page's island asks the video route
// again. Pure: an answer in, a delay out; the island owns the timer (seazn-video-poll.ts) and the wiring.
//
// A signed URL carries its token in the path and the token has a short life, so the island must hold a fresh URL BEFORE the one it
// plays lapses: nothing here assumes a playing Cloudflare HLS survives its token's expiry. The server re-mints inside its own window
// (`SEAZN_TOKEN_REFRESH_BEFORE_SECONDS`, 5 min, where `cf-playback.ts` stops reusing a cached token), and every answer that plays a
// Cloudflare address (live, or the interim `hls` recording) is re-read at `SEAZN_VIDEO_POLL_FLOOR_MS` (30 s). The floor is shorter
// than that window (the schedule test pins it), so each re-read also carries the refresh, and a same-token answer is a no-op to the
// player (seazn-playback.ts). The floor is also the least any re-read waits, so a clock that is wrong cannot hammer the route.
//
// Why the floor and not the token's refresh point (~55 min): what ends the state on screen comes BEFORE that point.
//   - LIVE (Task 19; the Task 15 review's r3): the organiser stops. At the floor an open page learns it within one poll, and turns
//     to the recording as soon as one is signed, instead of keeping a dead player under a "Live" label for up to an hour.
//   - The interim REPLAY (Task 19 fix round 1, I1): the organiser goes live again (Start another, after half-time or a failed run).
//     At the floor an open page turns to the new live player within one poll, instead of playing the first half's recording beside
//     a live score for up to an hour. The same holds for Match Day's preview, which runs this island (court-stream-preview.tsx).
// The route is on the poll bucket and signs from the server's token cache, so a read every 30 s per viewer is the cost of the
// match centre's own poll, not of a mint.
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";

/** The plan's 30 s: how long a page with nothing to play waits to look again, and the least any re-read waits. */
export const SEAZN_VIDEO_POLL_FLOOR_MS = 30_000;

/** Milliseconds until the island reads the route again, or `null` when no timer is owed.
 *   - no answer yet, or nothing to show (warming; ended with no recording signed yet): the floor;
 *   - `live`: the floor, so a Stop reaches an open page within one poll (the recordings listed beside it do not play, so they set no
 *     timer of their own);
 *   - replay with an `hls` part (the interim Cloudflare recording): the floor, so a second Go live reaches an open page within one
 *     poll, and the recording's token is refreshed on the way;
 *   - replay of `embed` parts alone (the replay host's own iframe, Task 25): no timer, because swapping an iframe's `src` restarts it.
 *     That page re-reads when the viewer picks a part that has expired. (Task 25 owes it the restart read I1 gave the `hls` replay.) */
export function nextVideoFetchMs(video: PublicFixtureVideo | null): number | null {
  if (video === null) return SEAZN_VIDEO_POLL_FLOOR_MS;
  if (video.live !== null) return SEAZN_VIDEO_POLL_FLOOR_MS;
  if (video.replay.length === 0) return SEAZN_VIDEO_POLL_FLOOR_MS;
  if (video.replay.some((p) => p.player === "hls")) return SEAZN_VIDEO_POLL_FLOOR_MS;
  return null;
}
