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
//
// A HIDDEN page reads nothing (Phase 1 review I2): a page opened in a background tab does not read until it is shown, and hiding one
// drops its timer. The read it owed happens when the page is shown again, at most one floor after the last read began (so a page the
// viewer returns to after a while reads at once, and a blink cannot hammer the route). That one read is also how a page the viewer is
// looking at catches up with a long empty-answer backoff (seazn-video-schedule.ts). A read in flight when the page hides still
// delivers its answer. The loop counts the empty answers in a row for the schedule's backoff; a failed read neither adds to the run
// nor ends it.
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { SEAZN_VIDEO_POLL_FLOOR_MS, isEmptyVideo, nextVideoFetchMs } from "./seazn-video-schedule";

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
   *  Never called after `stop`. */
  onVideo: (video: PublicFixtureVideo, answer: { rebuild: boolean }) => void;
  /** When the fixture is settled (ms; the page's `settledAt`): an empty answer from then on ends the loop. Absent or null: never. */
  settledAtMs?: number | null;
  /** The page's visibility. Absent: the document's (the island passes none); a test passes its own. */
  visibility?: PageVisibility;
}
export interface VideoPoll {
  stop: () => void;
  refreshSoon: () => void;
}

export function startVideoPoll({ fetchVideo, onVideo, settledAtMs = null, visibility }: VideoPollHooks): VideoPoll {
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
      const video = await fetchVideo(mine.signal);
      if (stopped || mine.signal.aborted) return;
      const rebuild = rebuildNext;
      rebuildNext = false;
      onVideo(video, { rebuild });
      inFlight = null;
      emptyStreak = isEmptyVideo(video) ? emptyStreak + 1 : 0;
      schedule(nextVideoFetchMs(video, { nowMs: Date.now(), settledAtMs, emptyStreak }));
    } catch {
      if (stopped || mine.signal.aborted) return;
      inFlight = null;
      schedule(SEAZN_VIDEO_POLL_FLOOR_MS);
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
  };
}
