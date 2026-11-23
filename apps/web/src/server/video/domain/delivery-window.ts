// server/video/domain/delivery-window.ts — which UTC days one measurement of a Seazn session's delivered minutes reads (Seazn-hosted
// video, Phase 3, Task 31). PURE: no database, no network, no clock of its own (the caller passes `now`).
//
// Both vendors bucket viewing by UTC day (Cloudflare's GraphQL takes `date_geq`/`date_leq` dates; the replay host charts its watch
// time per UTC day), so a measurement is a run of whole UTC dates, and `fixture_video_delivery.*_measured_through` (V546) holds the
// last one counted. The rules (controller ruling 3, 2026-11-23):
//   * DAILY (`dailyWindow`): from the day after the last one measured — or the session's first day, when it was never measured —
//     THROUGH YESTERDAY, both included. Today is never read: it has not finished. A second run on the same day therefore reads
//     nothing, and the next day's run reads exactly the one new day; a pass missed for days catches up in one read.
//   * Cloudflare answers at most CF_ANALYTICS_MAX_WINDOW_DAYS dates per query. A caller that passes `maxDays` gets the LAST that
//     many dates and `clamped: true` when the start lay further back — a guard on what should not happen (a live read covers a
//     session that ended within SEAZN_LIVE_MEASURE_DAYS and lasted at most MAX_DURATION_MINUTES), never a silent drop.
//   * FINAL (`finalWindow`): a replay host's copy answers nothing once removed (controller ruling 2), so the read taken just before
//     the removal covers the same start up to NOW, today's partial day included. It never moves `*_measured_through`: the copy
//     leaves the daily read with its removal, and the session's other copies are still owed those days.
const DAY_MS = 86_400_000;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The UTC midnight that starts the day `at` falls on. */
export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
/** The last millisecond of `day` (a UTC midnight): the end of a whole-day window sent as instants. */
export function endOfDay(day: Date): Date {
  return new Date(utcDay(day).getTime() + DAY_MS - 1);
}
const plusDays = (day: Date, n: number): Date => new Date(day.getTime() + n * DAY_MS);

/** A stored `date` column's text (`YYYY-MM-DD`, read as `::text`) as its UTC midnight; null stays null. A text that is not a real
 *  date throws, naming it: a day read as some other day would count minutes twice or never. */
export function dayOf(text: string | null): Date | null {
  if (text === null) return null;
  const m = YMD.exec(text);
  const at = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (at === null || dayText(at) !== text) throw new RangeError(`delivery window: ${JSON.stringify(text)} is not a date (YYYY-MM-DD)`);
  return at;
}
/** A UTC midnight as the `YYYY-MM-DD` a `date` column stores. */
export function dayText(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export interface DayWindow {
  /** The first and last UTC dates read, as UTC midnights; both included. */
  from: Date;
  through: Date;
  days: number;
  /** The start was moved forward to keep the window within `maxDays`. */
  clamped: boolean;
}

/** The days a DAILY read covers: from the day after `measuredThrough` (or `firstAt`'s UTC date, never measured) through yesterday.
 *  Null: no finished day is left to read. `maxDays` keeps the LAST that many dates. */
export function dailyWindow(a: { firstAt: Date; measuredThrough: Date | null; now: Date; maxDays?: number }): DayWindow | null {
  const through = plusDays(utcDay(a.now), -1);
  let from = a.measuredThrough === null ? utcDay(a.firstAt) : plusDays(utcDay(a.measuredThrough), 1);
  if (from.getTime() > through.getTime()) return null;
  let clamped = false;
  if (a.maxDays !== undefined) {
    const earliest = plusDays(through, -(a.maxDays - 1));
    if (from.getTime() < earliest.getTime()) {
      from = earliest;
      clamped = true;
    }
  }
  return { from, through, days: Math.round((through.getTime() - from.getTime()) / DAY_MS) + 1, clamped };
}

/** The span a FINAL read covers, just before a copy is removed: the daily read's start up to `now`. Null: nothing is left before
 *  `now` (a stored day at or past today). */
export function finalWindow(a: { firstAt: Date; measuredThrough: Date | null; now: Date }): { from: Date; to: Date } | null {
  const from = a.measuredThrough === null ? utcDay(a.firstAt) : plusDays(utcDay(a.measuredThrough), 1);
  if (from.getTime() > utcDay(a.now).getTime()) return null;
  return { from, to: a.now };
}
