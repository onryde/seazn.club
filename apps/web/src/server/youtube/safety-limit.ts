// server/youtube/safety-limit.ts — the channel-safety read's IN-PROCESS limit (Phase 0 fix round 2). lib/rate-limit.ts lets every call
// through when no REDIS_URL is set, and prod runs without Redis, so the safety check (safety-check.ts) falls back to this when the Redis
// limiter is not configured: a fixed window per connection, YOUTUBE_SAFETY_CHECK_LIMIT reads per window. Per process, so each machine
// holds its own count (a bound on a loop, not an exact global quota). The map is bounded: expired windows are pruned before it grows past
// MAX_TRACKED, and past that the oldest entry goes.
import { YOUTUBE_SAFETY_CHECK_LIMIT } from "@/lib/youtube";

const MAX_TRACKED = 10_000;
const windows = new Map<string, { start: number; count: number }>();

/** Takes one read for `connectionId` at `now`: true while the window has room, false once it is spent. */
export function takeSafetyRead(connectionId: string, now: Date, limit: { max: number; windowSeconds: number } = YOUTUBE_SAFETY_CHECK_LIMIT): boolean {
  const t = now.getTime();
  const span = limit.windowSeconds * 1000;
  let w = windows.get(connectionId);
  if (w === undefined || t - w.start >= span) {
    windows.delete(connectionId);
    if (windows.size >= MAX_TRACKED) prune(t, span);
    w = { start: t, count: 0 };
    windows.set(connectionId, w);
  }
  w.count += 1;
  return w.count <= limit.max;
}

function prune(t: number, span: number): void {
  for (const [k, w] of windows) if (t - w.start >= span) windows.delete(k);
  // Still full of live windows: drop the oldest (a Map iterates in insertion order).
  while (windows.size >= MAX_TRACKED) windows.delete(windows.keys().next().value!);
}

/** Test-only: forget every window. */
export function __resetSafetyReadsForTests(): void {
  windows.clear();
}

/** Test-only: how many connections are tracked (the bound's witness). */
export function __trackedSafetyReadsForTests(): number {
  return windows.size;
}
