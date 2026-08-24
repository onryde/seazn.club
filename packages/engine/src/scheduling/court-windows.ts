// Court availability (P9.5 / D5b.5 — venues & courts design doc,
// "`usableWindows` algorithm (normative)"). Pure and deterministic: no DB, no
// wall-clock read, no random. The DB loader lives usecase-side; the engine
// only ever sees rows already fetched.
//
// This is the ONE function every side must ask "is this time usable on this
// court". The repo's recurring defect is exactly the fork this replaces — a
// placer that filters one way and a verifier that filters another (P9's
// `court_tag_mismatch` is the worked example, and `candidate-courts.ts` is
// the shape this module copies deliberately).
//
// Shapes mirror V367 exactly so nothing is lost in translation:
//   * `court_hours` — (weekday 0=Sunday, open_min, close_min), minutes from
//     local midnight, 0 <= open < close <= 1440. MULTIPLE rows per weekday
//     are legal and mean a multi-range day; they are validated non-overlapping
//     at write time (usecases/venues.ts), never here.
//   * `court_exceptions` — PRIMARY KEY (court_id, date), so a date carries at
//     most ONE exception: either `closed`, or exactly one override range.
//     A multi-range exception day is unrepresentable in the schema.
//
// Two semantics that are decisions, not accidents:
//
//   1. "No calendar declared" is a property of the COURT, not of the day.
//      A court with zero `court_hours` rows is open all day, every day
//      (design doc step 1: calendars strictly SUBTRACT — a court with no
//      hours must not become unschedulable). A court that HAS hours but
//      none for Tuesday is CLOSED on Tuesday; that is a declared calendar
//      saying "not this weekday", not an absent one.
//   2. `close_min = 1440` is midnight at the END of the day. It must be
//      resolved as 00:00 on the FOLLOWING date — "24:00" is not a time
//      `zonedTimeToUtc` can parse, and treating it as 00:00 same-day would
//      silently invert the range.

import { weekdayOfYmd, ymdAddDays, zonedTimeToUtc, type Ymd } from "./tz.ts";

/** A half-open instant interval, epoch ms. */
export interface Window {
  readonly from: number;
  readonly to: number;
}

/** A blackout as the scheduler stores it. An unset `court` means GLOBAL —
 *  every court — which is the semantics all three pre-P9.5 implementations
 *  already agreed on (and A11: the value is a court ID, not a name).
 *
 *  Deliberately NOT exported: `calendar.ts` already exports a `Blackout` of
 *  this shape, and two same-named exports off `scheduling/index.ts` is an
 *  ambiguous re-export. Callers pass object literals, which structurally
 *  satisfy both. Kept as a local name rather than imported from calendar.ts so
 *  this module keeps its "no scheduling imports" property — it is a leaf, and
 *  calendar.ts imports IT. */
interface Blackout {
  readonly court?: string;
  readonly from: number;
  readonly to: number;
}

/** One `court_hours` row, verbatim. */
export interface CourtHoursRow {
  /** 0 = Sunday, matching `weekdayOfYmd` and V367's own convention. */
  readonly weekday: number;
  readonly openMin: number;
  readonly closeMin: number;
}

/** One `court_exceptions` row, verbatim. `closed` and the range are mutually
 *  exclusive — the table's CHECK constraint enforces it. */
export interface CourtExceptionRow {
  readonly date: Ymd;
  readonly closed: boolean;
  readonly openMin?: number;
  readonly closeMin?: number;
}

/** Everything `usableWindows` needs about one court. */
export interface CourtCalendar {
  readonly courtId: string;
  /** Empty = NO calendar declared for this court — see module header, note 1. */
  readonly hours: readonly CourtHoursRow[];
  readonly exceptions: readonly CourtExceptionRow[];
}

export interface WindowConfig {
  /** `settings.orgTz` — the governing clock (#448). `settings.tz` is display
   *  only and must never reach this function. */
  readonly tz: string;
  /** Empty or absent = unrestricted, the same "empty = unrestricted" rule the
   *  placer already applies. */
  readonly sessionWindows?: readonly Window[];
  readonly blackouts?: readonly Blackout[];
}

const WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
const MINUTES_PER_DAY = 1440;

/** Minutes from local midnight -> the instant that wall-clock time falls on,
 *  in `tz`. Goes through `zonedTimeToUtc` so a DST day is handled by civil
 *  arithmetic, never by adding milliseconds. Minutes at or past 1440 roll to
 *  the following date (module header, note 2). */
function instantAt(ymd: Ymd, minutes: number, tz: string): number {
  const day = minutes >= MINUTES_PER_DAY ? ymdAddDays(ymd, Math.floor(minutes / MINUTES_PER_DAY)) : ymd;
  const rem = minutes % MINUTES_PER_DAY;
  const hh = String(Math.floor(rem / 60)).padStart(2, "0");
  const mm = String(rem % 60).padStart(2, "0");
  return zonedTimeToUtc(day, `${hh}:${mm}`, tz);
}

/** Maximal disjoint ordered windows — the normative algorithm's step 4. */
function normalize(windows: readonly Window[]): Window[] {
  const sorted = windows.filter((w) => w.to > w.from).sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Window[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && w.from <= last.to) {
      if (w.to > last.to) out[out.length - 1] = { from: last.from, to: w.to };
      continue;
    }
    out.push({ from: w.from, to: w.to });
  }
  return out;
}

function intersect(base: readonly Window[], cuts: readonly Window[]): Window[] {
  const out: Window[] = [];
  for (const b of base) {
    for (const c of cuts) {
      const from = Math.max(b.from, c.from);
      const to = Math.min(b.to, c.to);
      if (to > from) out.push({ from, to });
    }
  }
  return out;
}

function subtract(base: readonly Window[], cuts: readonly Window[]): Window[] {
  let pieces = [...base];
  for (const cut of cuts) {
    const next: Window[] = [];
    for (const p of pieces) {
      if (cut.to <= p.from || cut.from >= p.to) {
        next.push(p);
        continue;
      }
      if (cut.from > p.from) next.push({ from: p.from, to: Math.min(cut.from, p.to) });
      if (cut.to < p.to) next.push({ from: Math.max(cut.to, p.from), to: p.to });
    }
    pieces = next;
  }
  return pieces;
}

/** Step 1: the court's own declared availability for one date, before any
 *  schedule-level narrowing. */
function baseFor(calendar: CourtCalendar, day: Ymd, tz: string): Window[] {
  const exception = calendar.exceptions.find((e) => e.date === day);
  if (exception !== undefined) {
    if (exception.closed || exception.openMin === undefined || exception.closeMin === undefined) return [];
    return [
      {
        from: instantAt(day, exception.openMin, tz),
        to: instantAt(day, exception.closeMin, tz),
      },
    ];
  }
  if (calendar.hours.length === 0) {
    // No calendar declared for this court at all — the full civil day, which
    // on a DST date is simply 23 or 25 hours long. No UTC arithmetic.
    return [{ from: instantAt(day, 0, tz), to: instantAt(ymdAddDays(day, 1), 0, tz) }];
  }
  const weekday = weekdayOfYmd(day);
  return calendar.hours
    .filter((h) => WEEKDAY_NAMES[h.weekday] === weekday)
    .map((h) => ({ from: instantAt(day, h.openMin, tz), to: instantAt(day, h.closeMin, tz) }));
}

/**
 * The usable windows for one court across a range of org-tz calendar days.
 *
 * Implements the D5 normative algorithm: exceptions override weekday hours,
 * intersected with the schedule's session windows, minus applicable blackouts,
 * returned as maximal disjoint ordered windows in org-tz civil time.
 *
 * @param calendar the court's own `court_hours` / `court_exceptions`.
 * @param range inclusive org-tz calendar dates.
 * @param config the governing zone, session windows and blackouts.
 */
export function usableWindows(
  calendar: CourtCalendar,
  range: { readonly from: Ymd; readonly to: Ymd },
  config: WindowConfig,
): Window[] {
  const sessions = config.sessionWindows ?? [];
  const cuts = (config.blackouts ?? []).filter(
    (b) => b.court === undefined || b.court === calendar.courtId,
  );
  const out: Window[] = [];
  for (let day = range.from; day <= range.to; day = ymdAddDays(day, 1)) {
    const base = baseFor(calendar, day, config.tz);
    const narrowed = sessions.length > 0 ? intersect(base, sessions) : base;
    out.push(...subtract(normalize(narrowed), cuts));
  }
  return normalize(out);
}
