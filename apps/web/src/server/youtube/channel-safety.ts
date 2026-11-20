// server/youtube/channel-safety.ts — the channel-safety warning (Phase 0, YouTube channel safety, Task 3): is this channel young, and
// how many SHORT broadcasts did it run in the last day? Pure: no database, no network. The facts come from the port
// (`channelCreatedAt`, `recentBroadcasts`) or the connection's stored `channel_created_at` (V539); the thresholds are lib/youtube.ts's.
// A warning only: nothing here blocks a Go live.
import {
  YOUTUBE_SHORT_BROADCAST_MINUTES, YOUTUBE_SHORT_BROADCAST_WARN_COUNT, YOUTUBE_SHORT_BROADCAST_WINDOW_HOURS, YOUTUBE_YOUNG_CHANNEL_DAYS,
} from "@/lib/youtube";
import type { BroadcastSpan } from "./port";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;


/** `young`: created fewer than YOUTUBE_YOUNG_CHANNEL_DAYS before `now` (an unknown creation date is not young). `shortRecent`: broadcasts
 *  that started within the last YOUTUBE_SHORT_BROADCAST_WINDOW_HOURS and ended within YOUTUBE_SHORT_BROADCAST_MINUTES of their start (one
 *  still live is not short). `warn`: young, or at least YOUTUBE_SHORT_BROADCAST_WARN_COUNT short ones. */
export function channelSafetyWarning(f: { createdAt: Date | null; broadcasts: BroadcastSpan[]; now: Date }): {
  young: boolean; shortRecent: number; warn: boolean;
} {
  const now = f.now.getTime();
  const young = f.createdAt !== null && now - f.createdAt.getTime() < YOUTUBE_YOUNG_CHANNEL_DAYS * DAY_MS;
  const windowStart = now - YOUTUBE_SHORT_BROADCAST_WINDOW_HOURS * 60 * MINUTE_MS;
  const shortRecent = f.broadcasts.filter(
    (b) => b.endedAt !== null && b.startedAt.getTime() >= windowStart
      && b.endedAt.getTime() - b.startedAt.getTime() < YOUTUBE_SHORT_BROADCAST_MINUTES * MINUTE_MS,
  ).length;
  return { young, shortRecent, warn: young || shortRecent >= YOUTUBE_SHORT_BROADCAST_WARN_COUNT };
}
