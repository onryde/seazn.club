// Seazn-hosted video (Phase 1 Task 15): the island's read loop, outside React so it can be driven by a fake clock. It reads the video
// route at once and again whenever `nextVideoFetchMs` says (seazn-video-schedule.ts), hands each good answer to the page, and keeps
// whatever the page already shows when a read fails (a flaky network must not blank a playing video: the next try is 30 s on).
//
// `refreshSoon` is the island's ask for a read outside the schedule: a player that gave up (a fatal error: a token that lapsed anyway,
// or a blip on the manifest request), or (Task 25) a viewer who picked a replay part whose token has expired. It never reads sooner
// than the floor after the last read began, so an error that repeats cannot hammer the route.
//
// The ask is also the player's "I am dead": the NEXT answer is delivered with `rebuild: true`, whatever it holds. A token that is still
// good was not what failed, so the same address would otherwise be a no-op to the player and leave it on "can't play" until the viewer
// reloads; the island answers `rebuild` by mounting a fresh player. One answer spends the flag, and a read that fails does not.
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { SEAZN_VIDEO_POLL_FLOOR_MS, nextVideoFetchMs } from "./seazn-video-schedule";

export interface VideoPollHooks {
  /** One read of the route. Rejects on any failure; honours `signal` (the stop aborts it). */
  fetchVideo: (signal: AbortSignal) => Promise<PublicFixtureVideo>;
  /** Each good answer, in order. `rebuild`: a player asked for this read after giving up, so it is to be rebuilt, not updated.
   *  Never called after `stop`. */
  onVideo: (video: PublicFixtureVideo, answer: { rebuild: boolean }) => void;
}
export interface VideoPoll {
  stop: () => void;
  refreshSoon: () => void;
}

export function startVideoPoll({ fetchVideo, onVideo }: VideoPollHooks): VideoPoll {
  let stopped = false;
  let inFlight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastReadAt = -Infinity;
  /** A player gave up since the last answer was delivered. */
  let rebuildNext = false;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number | null) => {
    clearTimer();
    if (stopped || ms === null) return;
    timer = setTimeout(() => void read(), ms);
  };

  async function read(): Promise<void> {
    timer = null;
    if (stopped || inFlight !== null) return;
    const mine = new AbortController();
    inFlight = mine;
    lastReadAt = Date.now();
    try {
      const video = await fetchVideo(mine.signal);
      if (stopped || mine.signal.aborted) return;
      const rebuild = rebuildNext;
      rebuildNext = false;
      onVideo(video, { rebuild });
      inFlight = null;
      schedule(nextVideoFetchMs(video, new Date()));
    } catch {
      if (stopped || mine.signal.aborted) return;
      inFlight = null;
      schedule(SEAZN_VIDEO_POLL_FLOOR_MS);
    }
  }

  void read();

  return {
    stop() {
      stopped = true;
      clearTimer();
      inFlight?.abort();
      inFlight = null;
    },
    refreshSoon() {
      if (stopped) return;
      // Marked even while a read is in flight: that read's answer is the first one after the failure.
      rebuildNext = true;
      if (inFlight !== null) return;
      schedule(Math.max(0, lastReadAt + SEAZN_VIDEO_POLL_FLOOR_MS - Date.now()));
    },
  };
}
