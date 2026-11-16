"use client";
// "Video ends in 12 s" (O16, owner 2026-11-16: "have countdown in court match day, like streaming will be free in 30s"): the tail of a
// linked court after its last streamed match's result, counted down on the desk. The SERVER decides whether there is a tail and when
// it ends (`MatchDayCourtStream.tail_ends_at`, from COURT_AUTO_STOP_AFTER_RESULT_SECONDS); this only counts down to that instant and
// never knows the rule. Gone at 0; the desk's next poll then reads the court's normal state. If the next match's stream starts first
// the court's `tail_ends_at` arrives null and the parent stops drawing it.
//
// The count runs on the page's own clock, anchored to the view's server `now` (`viewNow`), so a laptop whose clock is a few seconds
// off still counts true; each poll brings a new `viewNow` and re-anchors it. The first render counts from `viewNow` itself, so the
// server's markup and the first client render agree (no hydration mismatch) before the one-second tick starts. Seconds are tabular
// figures, so the line does not twitch as it counts.
import { useEffect, useState } from "react";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";

/** Whole seconds left until `endMs`, rounded UP (0.4 s left reads "1 s"; 0 is the line gone). */
function secondsLeft(endMs: number, nowMs: number): number {
  return Math.ceil((endMs - nowMs) / 1000);
}

export function CourtTailCountdown({
  dict,
  tailEndsAt,
  viewNow,
  clock = Date.now,
  className = "",
}: {
  dict: Dict;
  /** `stream_link.tail_ends_at`: the instant the court's video stops by itself. */
  tailEndsAt: string;
  /** The view's server `now` (ISO): the instant the count is anchored to. Without it the page's own clock is the anchor, from mount. */
  viewNow?: string;
  /** The page's clock in ms: `Date.now`, or a fixed one in a test. */
  clock?: () => number;
  className?: string;
}) {
  const endMs = Date.parse(tailEndsAt);
  const [nowMs, setNowMs] = useState<number | null>(viewNow === undefined ? null : Date.parse(viewNow));
  useEffect(() => {
    const anchor = viewNow === undefined ? clock() : Date.parse(viewNow);
    const startedAt = clock();
    setNowMs(anchor);
    const id = setInterval(() => {
      const next = anchor + (clock() - startedAt);
      setNowMs(next);
      if (secondsLeft(endMs, next) <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [viewNow, endMs, clock]);
  if (nowMs === null || Number.isNaN(endMs)) return null;
  const seconds = secondsLeft(endMs, nowMs);
  if (seconds <= 0) return null;
  return (
    // A span, not a p: a court row's line sits inside its button, which takes phrasing content only.
    <span data-testid="md-cs-tail" role="timer" data-seconds={seconds} className={`block tabular-nums ${className}`}>
      {t(dict, "matchDay.courtStream.tailEnds", { seconds })}
    </span>
  );
}
