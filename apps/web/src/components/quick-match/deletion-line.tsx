"use client";
// "Not saved — deleted on {date}" under Save (owner 2026-11-12; review I1, controller ruling 2026-11-13): the day must
// NEVER be later than the day the match is really deleted. The sweep deletes on the instant (`expires_at < now`), and only
// the guest's browser knows the guest's zone, so the live page names the day in it (`Intl`'s own zone, in the page's
// language). The server cannot: its HTML (and a browser without the script) names the UTC day of `expires_at − 14h`, the
// earliest calendar day any zone on Earth (UTC−12 .. UTC+14) reads the instant as — early by a day at most, never late.
//
// The setup form's B4h pattern: `useSyncExternalStore` with a server snapshot, so hydration paints the server's day first
// and React swaps in the guest's after it, with no mismatch. A day does not change under a page, so nothing is subscribed.
import { useSyncExternalStore } from "react";
import { interpolate } from "@/lib/i18n-runtime";
import { formatPublicInstant } from "@/lib/public-date-locale";

/** How far before the instant the fallback names its day: UTC+14 (Line Islands) is the furthest zone from UTC. */
export const NEVER_LATE_HOURS = 14;
const DAY: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };

/** The calendar day of `iso` in `timeZone`, in `lang`'s words; null for an instant that does not parse. */
export function deletionDayIn(iso: string, lang: string, timeZone: string): string | null {
  return formatPublicInstant(lang, timeZone, iso, DAY);
}

/** The day that is never late: the UTC day of `iso − NEVER_LATE_HOURS`; null for an instant that does not parse. */
export function deletionDayFallback(iso: string, lang: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return formatPublicInstant(lang, "UTC", new Date(ms - NEVER_LATE_HOURS * 3_600_000).toISOString(), DAY);
}

const subscribeToNothing = () => () => {};

export function QuickMatchDeletionLine({
  expiresAt,
  lang,
  line,
}: {
  /** The row's `expires_at`, ISO 8601. */
  expiresAt: string;
  /** The page's locale: the day is written in it. */
  lang: string;
  /** The dictionary's line with its `{date}` slot left in ("Not saved — deleted on {date}"). */
  line: string;
}) {
  const day = useSyncExternalStore(
    subscribeToNothing,
    () => deletionDayIn(expiresAt, lang, Intl.DateTimeFormat().resolvedOptions().timeZone),
    () => deletionDayFallback(expiresAt, lang),
  );
  if (day === null) return null;
  return (
    <p data-testid="qm-not-saved" className="text-center text-[13px] leading-snug text-[#b7aede] [overflow-wrap:anywhere]">
      {interpolate(line, { date: day })}
    </p>
  );
}
