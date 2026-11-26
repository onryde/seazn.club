// Seazn-hosted video (Phase 1 Task 15): the island's read loop, outside React so it can be driven by a fake clock. It reads the video
// route at once and again whenever `nextVideoFetchMs` says (seazn-video-schedule.ts), hands each good answer to the page, and keeps
// whatever the page already shows when a read fails (a flaky network must not blank a playing video). Failed reads in a row retry on
// the schedule's ladder, 30 s then every 60 s (review N6, `backoffMs`), so an outage or a 429 does not keep every page on the floor.
//
// `refreshSoon` is the island's ask for a read outside the schedule after a player gave up (a fatal error: a token that lapsed anyway,
// or a blip on the manifest request). `readSoon` (Task 25, carry 3) is the replay host's frame asking for a fresh address because the one
// it holds has a token that has passed (a part picked, or the first part, from an answer read long ago): the same read, WITHOUT the
// rebuild below, so the waiting frame keeps its element and loads the fresh address. Neither reads sooner than the floor after the
// last read began, so an ask that repeats cannot hammer the route.
//
// The ask is also the player's "I am dead": the NEXT answer is delivered with `rebuild: true`, whatever it holds. A token that is still
// good was not what failed, so the same address would otherwise be a no-op to the player and leave it on "can't play" until the viewer
// reloads; the island answers `rebuild` by mounting a fresh player. One answer spends the flag, and a read that fails does not.
//
// A HIDDEN page reads nothing (Phase 1 review I2): a page opened in a background tab does not read until it is shown, and hiding one
// drops its timer. The read it owed happens when the page is shown again, at most one floor after the last read began (so a page the
// viewer returns to after a while reads at once, and a blink cannot hammer the route). A read in flight when the page hides still
// delivers its answer. The loop counts the empty answers in a row for the schedule's backoff; a failed read neither adds to the run
// nor ends it (it counts its own). The page's plan hints (`kickoffAtMs`, `activeUntilMs`: review N1) are handed to the schedule,
// which holds the floor while the match is hot.
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { SEAZN_VIDEO_POLL_FLOOR_MS, backoffMs, isEmptyVideo, nextVideoFetchMs } from "./seazn-video-schedule";

/** Whether the page is hidden, and its changes (`document`'s visibility, in the browser). */
export interface PageVisibility {
  hidden: () => boolean;
  /** Calls `listener` on every change; answers its removal. */
  onChange: (listener: () => void) => () => void;
}

/** The browser's: `document.hidden` and its `visibilitychange`. Null where there is no document (a node test, a server render). */
function documentVisibility(): PageVisibility | null {
  if (typeof document === "undefined") return null;
  return {
    hidden: () => document.hidden,
    onChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

export interface VideoPollHooks {
  /** One read of the route. Rejects on any failure; honours `signal` (the stop aborts it). */
  fetchVideo: (signal: AbortSignal) => Promise<PublicFixtureVideo>;
  /** Each good answer, in order. `rebuild`: a player asked for this read after giving up, so it is to be rebuilt, not updated.
   *  Never called after `stop`. It is handed the answer `hold` made of the read, if there is one. */
  onVideo: (video: PublicFixtureVideo, answer: { rebuild: boolean }) => void;
  /** The video to SHOW for an answer, when it is not the answer itself: the island keeps the address a player is already playing while
   *  its token is not due (seazn-held-address.ts), because a native player is re-pointed, and stops, by every changed address. What
   *  it returns is what `onVideo` is given AND what the next read is timed from (the schedule reads its expiries: a settled recording
   *  is re-read before the token the player HOLDS is due, not the newest one's). Absent: the answer as it came. */
  hold?: (video: PublicFixtureVideo, answer: { rebuild: boolean }) => PublicFixtureVideo;
  /** When the fixture is settled (ms; the page's `settledAt`): an empty answer from then on ends the loop. Absent or null: never. */
  settledAtMs?: number | null;
  /** Review N1, from the page's plan: the fixture's kick-off (ms), and until when it counts as active (ms). Either one makes an empty
   *  answer hold the floor (seazn-video-schedule.ts `isHotRead`). Absent or null: cold. */
  kickoffAtMs?: number | null;
  activeUntilMs?: number | null;
  /** The page's visibility. Absent: the document's (the island passes none); a test passes its own. */
  visibility?: PageVisibility;
  /** Each failed read's error (Task 25: the island reports it, seazn-video-report.ts). Never called for the abort `stop` makes. */
  onReadFailed?: (err: unknown) => void;
}
export interface VideoPoll {
  stop: () => void;
  /** A player gave up: a read soon, and its answer rebuilds the players. */
  refreshSoon: () => void;
  /** A frame holds a lapsed address: a read soon, and its answer is an ordinary one (no rebuild). */
  readSoon: () => void;
}

/** Phase 1 review m8: a read not answered by then is given up (aborted) and counts as a failed read, so a hung request cannot freeze
 *  the island. */
export const SEAZN_VIDEO_FETCH_TIMEOUT_MS = 15_000;

export function startVideoPoll({ fetchVideo, onVideo, hold, settledAtMs = null, kickoffAtMs = null, activeUntilMs = null, visibility, onReadFailed }: VideoPollHooks): VideoPoll {
  const page = visibility ?? documentVisibility();
  const isHidden = () => page?.hidden() ?? false;
  let stopped = false;
  let inFlight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastReadAt = -Infinity;
  /** A player gave up since the last answer was delivered. */
  let rebuildNext = false;
  /** Empty answers in a row (the schedule's backoff). */
  let emptyStreak = 0;
  /** Failed reads in a row (review N6: the same ladder, capped at 60 s). Reset by any answer. */
  let failStreak = 0;
  /** The page was hidden while a read was due or in flight: the first read once it is shown is at most a floor after the last. */
  let owed = false;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  /** The wait until a floor has passed since the last read began (0 when it has). */
  const floorWait = () => Math.max(0, lastReadAt + SEAZN_VIDEO_POLL_FLOOR_MS - Date.now());
  const schedule = (ms: number | null) => {
    clearTimer();
    if (stopped || ms === null) {
      owed = false;
      return;
    }
    if (isHidden()) {
      owed = true;
      return;
    }
    const wait = owed ? Math.min(ms, floorWait()) : ms;
    owed = false;
    timer = setTimeout(() => void read(), wait);
  };

  async function read(): Promise<void> {
    timer = null;
    if (stopped || inFlight !== null) return;
    const mine = new AbortController();
    inFlight = mine;
    lastReadAt = Date.now();
    try {
      const giveUp = setTimeout(() => mine.abort(), SEAZN_VIDEO_FETCH_TIMEOUT_MS);
      const video = await fetchVideo(mine.signal).finally(() => clearTimeout(giveUp));
      if (stopped) return;
      const rebuild = rebuildNext;
      rebuildNext = false;
      const shown = hold ? hold(video, { rebuild }) : video;
      onVideo(shown, { rebuild });
      inFlight = null;
      failStreak = 0;
      emptyStreak = isEmptyVideo(shown) ? emptyStreak + 1 : 0;
      schedule(nextVideoFetchMs(shown, { nowMs: Date.now(), settledAtMs, emptyStreak, kickoffAtMs, activeUntilMs }));
    } catch (err) {
      if (stopped) return;   // only stop() aborts besides the give-up, and the give-up is a failed read
      inFlight = null;
      failStreak += 1;
      schedule(backoffMs(failStreak));
      onReadFailed?.(err);
    }
  }

  const unlisten = page?.onChange(() => {
    if (stopped) return;
    if (isHidden()) {
      // A read that was waiting is dropped and owed; one in flight delivers, and its schedule (hidden) owes the next.
      if (timer !== null || inFlight !== null) owed = true;
      clearTimer();
      return;
    }
    // Shown: the owed read, at most a floor after the last one. An answer still in flight schedules it itself.
    if (owed && inFlight === null) schedule(floorWait());
  });

  if (isHidden()) owed = true;
  else void read();

  return {
    stop() {
      stopped = true;
      clearTimer();
      unlisten?.();
      inFlight?.abort();
      inFlight = null;
    },
    refreshSoon() {
      if (stopped) return;
      // Marked even while a read is in flight: that read's answer is the first one after the failure.
      rebuildNext = true;
      if (inFlight !== null) return;
      schedule(floorWait());
    },
    readSoon() {
      // A read in flight already brings a fresh address; a pending rebuild is left as it was. After a stop, `schedule` sets nothing.
      if (inFlight !== null) return;
      schedule(floorWait());
    },
  };
}
