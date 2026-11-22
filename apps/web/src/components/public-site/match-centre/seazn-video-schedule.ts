// Seazn-hosted video (Phase 1 Task 15; spec §5.1; recommendation 2026-11-21): WHEN the match page's island asks the video route
// again. Pure: an answer and the loop's context in, a delay out; the island owns the timer (seazn-video-poll.ts) and the wiring.
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
//
// What is NOT read at the floor (Phase 1 review I2: an unbounded 30 s poll on every Seazn fixture page, open or forgotten):
//   - NOTHING TO SHOW backs off, 30 s -> 60 s -> 120 s -> 240 s, then every 5 min (`SEAZN_VIDEO_POLL_CEILING_MS`), counted over the
//     empty answers in a row; the first answer that shows something puts the page back on the floor. A page opened long before
//     kick-off costs a few reads an hour, and the island's visibility resume (seazn-video-poll.ts) still turns a page the viewer is
//     looking at to the live player within one floor.
//   - A SETTLED fixture (decided, and past the stream code's grace after it finished, so no new Go live can start: the page's
//     `settledAt`, seazn-video-plan.ts) has nothing more coming: an empty answer stops the loop, and an `hls` replay is re-read only at
//     its token's refresh point (it must be: a player whose token lapses mid-watch fails, and a rebuilt one starts again from 0).
//   - The hidden tab is the loop's own rule, not the schedule's: no read while `document.hidden` (seazn-video-poll.ts).
import { SEAZN_TOKEN_REFRESH_BEFORE_SECONDS } from "@/server/relay/config";
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";

/** The plan's 30 s: how long a page with nothing to play waits to look again at first, and the least any re-read waits. */
export const SEAZN_VIDEO_POLL_FLOOR_MS = 30_000;
/** Phase 1 review I2: the longest an empty answer's backoff waits (5 min). */
export const SEAZN_VIDEO_POLL_CEILING_MS = 5 * 60_000;

/** What the loop knows beside the answer. */
export interface VideoReadContext {
  /** The clock when the answer arrived (ms). */
  nowMs: number;
  /** When the fixture is settled (ms), from the page: decided, and past the window a new Go live can start in. Null while it is not
   *  (not decided yet, or no finish time). */
  settledAtMs: number | null;
  /** How many answers in a row had nothing to show, THIS one included (1 for the first empty answer). */
  emptyStreak: number;
}

/** An answer with nothing at all: no live and no part. */
export const isEmptyVideo = (video: PublicFixtureVideo): boolean => video.live === null && video.replay.length === 0;

/** Milliseconds until the island reads the route again, or `null` when no timer is owed.
 *   - no answer yet: the floor;
 *   - `live`: the floor, so a Stop reaches an open page within one poll (the recordings listed beside it do not play, so they set no
 *     timer of their own);
 *   - nothing to show: the backoff (floor doubling per empty answer in a row, to the ceiling); a settled fixture: no timer;
 *   - replay with an `hls` part (the interim Cloudflare recording): the floor, so a second Go live reaches an open page within one
 *     poll; once settled, the earliest `hls` token's refresh point instead (never sooner than the floor; an expiry that is not a date
 *     is the floor);
 *   - replay of `embed` parts alone (the replay host's own iframe, Task 25): no timer, because swapping an iframe's `src` restarts it.
 *     That page re-reads when the viewer picks a part that has expired. (Task 25 owes it the restart read I1 gave the `hls` replay.) */
export function nextVideoFetchMs(video: PublicFixtureVideo | null, at: VideoReadContext): number | null {
  if (video === null) return SEAZN_VIDEO_POLL_FLOOR_MS;
  if (video.live !== null) return SEAZN_VIDEO_POLL_FLOOR_MS;
  const settled = at.settledAtMs !== null && at.nowMs >= at.settledAtMs;
  if (video.replay.length === 0) {
    if (settled) return null;
    return Math.min(SEAZN_VIDEO_POLL_FLOOR_MS * 2 ** Math.max(0, at.emptyStreak - 1), SEAZN_VIDEO_POLL_CEILING_MS);
  }
  const hls = video.replay.filter((p) => p.player === "hls");
  if (hls.length === 0) return null;
  if (!settled) return SEAZN_VIDEO_POLL_FLOOR_MS;
  const refreshAt = Math.min(...hls.map((p) => Date.parse(p.expiresAt))) - SEAZN_TOKEN_REFRESH_BEFORE_SECONDS * 1000;
  const wait = refreshAt - at.nowMs;
  return Number.isFinite(wait) ? Math.max(SEAZN_VIDEO_POLL_FLOOR_MS, wait) : SEAZN_VIDEO_POLL_FLOOR_MS;
}
