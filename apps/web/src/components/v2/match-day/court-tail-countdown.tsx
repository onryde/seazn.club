"use client";
// "Video ends in 12 s" (O16, owner 2026-11-16: "have countdown in court match day, like streaming will be free in 30s"): the tail of a
// linked court after its last streamed match's result, counted down on the desk. The SERVER decides whether there is a tail and when
// it ends (`MatchDayCourtStream.tail_ends_at`, from the court's auto-stop delay); this only counts down to that instant and never knows
// the rule. Gone at 0; the desk's next poll then reads the court's normal state. If the next match's stream starts first (or the video
// is already ending) the court's `tail_ends_at` arrives null and the parent stops drawing it.
//
// The arithmetic is `tailSecondsLeft` (lib/match-day/tail-countdown.ts): anchored to the view's server `now`, so a reader's clock a few
// seconds, or an hour, off still counts true. The anchor is taken when a `viewNow` ARRIVES (keyed on it, render-phase), not when an
// effect happens to run, so a changed `tail_ends_at` under the same `viewNow` never rewinds the count. The first render counts from
// `viewNow` itself, so the server's markup and the first client render agree (no hydration mismatch) before the one-second tick starts.
// Seconds are tabular figures, so the line does not twitch as it counts.
import { useEffect, useState } from "react";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { tailSecondsLeft } from "@/lib/match-day/tail-countdown";

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
  /** The view's server `now` (ISO): the instant the count is anchored to. A caller with none draws no countdown. */
  viewNow: string;
  /** The page's clock in ms: `Date.now`, or a fixed one in a test. Keep it stable between renders. */
  clock?: () => number;
  className?: string;
}) {
  const [anchor, setAnchor] = useState(() => ({ viewNow, at: clock() }));
  const [nowMs, setNowMs] = useState(anchor.at);
  if (anchor.viewNow !== viewNow) {
    // A new view arrived: anchor to it now, on the reader's clock (React's render-phase adjustment, not an effect).
    const at = clock();
    setAnchor({ viewNow, at });
    setNowMs(at);
  }
  const seconds = tailSecondsLeft({ tailEndsAt, viewNow: anchor.viewNow, anchoredAtMs: anchor.at, nowMs });
  const done = seconds <= 0;
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setNowMs(clock()), 1000);
    return () => clearInterval(id);
  }, [clock, done]);
  if (done) return null;
  return (
    // A span, not a p: a court row's line sits inside its button, which takes phrasing content only.
    <span data-testid="md-cs-tail" role="timer" data-seconds={seconds} className={`block tabular-nums ${className}`}>
      {t(dict, "matchDay.courtStream.tailEnds", { seconds })}
    </span>
  );
}
