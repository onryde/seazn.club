// "Updated 12 s ago" / "Updated 2 min ago" (Match Day desk, owner 2026-11-17: "refresh button in match day and say countdown with
// refresh or click to refresh"): the whole seconds since the page last read the day, as the dictionary's two forms. Pure.
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";

/** Whole seconds from `since` to `now`, never below 0 (a clock that stepped back reads "0 s"). */
export function secondsSince(sinceMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
}

/** Under a minute in seconds, then whole minutes (59 s -> "59 s", 60 s -> "1 min", 119 s -> "1 min"). */
export function updatedAgo(dict: Dict, seconds: number): string {
  return seconds < 60
    ? t(dict, "matchDay.refresh.updatedSeconds", { n: seconds })
    : t(dict, "matchDay.refresh.updatedMinutes", { n: Math.floor(seconds / 60) });
}
