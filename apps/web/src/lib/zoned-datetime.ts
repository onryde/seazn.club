// Local date/time INPUT values ⇄ absolute instants, resolved in an EXPLICIT
// zone. Isomorphic and dependency-light — the scheduling panels are client
// components.
//
// WHY THIS EXISTS. `<input type="datetime-local">` and `<input type="date">`
// carry no offset: their value is a bare wall clock, and something has to
// decide which zone that wall clock belongs to. `new Date(value)` decides it is
// the BROWSER's — so an organiser working from a different zone than the venue
// types "12:00" meaning venue noon and stores their own noon, off by the whole
// offset. The server is not involved in the mistake: an ISO instant carries its
// offset and is never re-zoned.
//
// The governing zone is `settings.orgTz`, never `settings.tz` (#448) — the
// latter is the DISPLAY lane a division may override, and two divisions of one
// competition must not disagree about what a typed time means. Every function
// here takes the zone as an argument: there is no ambient default, no
// `process.env.TZ`, and no module-level fallback, because a wrong default is
// exactly the bug that was already shipped once.
//
// The zone MATH is not re-implemented here. `dayKeyInTz` / `hhmmInTz` /
// `zonedTimeToUtc` / `ymdAddDays` in the engine are the repo's one DST-correct
// implementation — a fixpoint over `Intl`, swept across all 418 zones — and
// this module only shapes their results into the strings an `<input>` wants.
// Do not add a second spelling of this conversion anywhere else.
import { dayKeyInTz, hhmmInTz, ymdAddDays, zonedTimeToUtc } from "@seazn/engine/scheduling/tz";

/** `<input type="datetime-local">` value: "YYYY-MM-DDTHH:MM". */
export type ZonedDateTimeInput = string;
/** `<input type="date">` value: "YYYY-MM-DD". */
export type ZonedDateInput = string;
/** `<input type="time">` value: "HH:MM", 24-hour. */
export type ZonedTimeInput = string;

/** Seconds are optional: some browsers append ":SS" once a step is set. */
const DATETIME_LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

const MS_PER_DAY = 86_400_000;

/**
 * A missing zone is a WIRING bug, and it must not be survivable.
 *
 * `Intl.DateTimeFormat(…, { timeZone: undefined })` silently resolves to the
 * host's zone, so a call site that forgot to pass `orgTz` would keep working —
 * as the browser-lane implementation this module replaces, producing exactly
 * the wrong instants it exists to prevent, with nothing on screen to show it.
 * `tsc` already rejects the omission; this is the backstop for anything that
 * reaches here without one, and it is deliberately louder than a wrong answer.
 */
function requireTz(tz: string): string {
  if (typeof tz !== "string" || tz.trim() === "") {
    throw new Error(
      "zoned-datetime: a venue timezone is required (settings.orgTz) — refusing to fall back to the host zone",
    );
  }
  return tz;
}

/** Epoch ms, or null when the value is not an instant we can render. */
function instantMs(iso: string | Date | number): number | null {
  const ms = typeof iso === "number" ? iso : new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// Instant → input value (the READ side)
// ---------------------------------------------------------------------------

/**
 * The `datetime-local` value that shows `iso` as `tz`'s wall clock.
 *
 * Empty string for anything unparseable: these values come out of a stored
 * config the panels never re-validate, and an input reading "NaN-aN-aNTaN:aN"
 * is a control the organiser cannot clear.
 */
export function zonedDateTimeInput(iso: string | Date | number, tz: string): ZonedDateTimeInput {
  requireTz(tz);
  const ms = instantMs(iso);
  return ms === null ? "" : `${dayKeyInTz(ms, tz)}T${hhmmInTz(ms, tz)}`;
}

/** The `date` value — the calendar day `iso` falls on in `tz`. */
export function zonedDateInput(iso: string | Date | number, tz: string): ZonedDateInput {
  requireTz(tz);
  const ms = instantMs(iso);
  return ms === null ? "" : dayKeyInTz(ms, tz);
}

/** The `time` value — the wall-clock time `iso` reads in `tz`. */
export function zonedTimeInput(iso: string | Date | number, tz: string): ZonedTimeInput {
  requireTz(tz);
  const ms = instantMs(iso);
  return ms === null ? "" : hhmmInTz(ms, tz);
}

// ---------------------------------------------------------------------------
// Input value → instant (the WRITE side)
// ---------------------------------------------------------------------------

/**
 * The instant a `YYYY-MM-DD` + `HH:MM` pair names in `tz`, as an ISO string.
 * Null when either half is not in the shape an input emits — callers already
 * refuse a half-typed row, and guessing at a malformed one would store a
 * silently different time.
 *
 * A local time that does not exist (the spring-forward gap) has no exact
 * answer; `zonedTimeToUtc` documents what it settles on. Every caller here
 * asks for a day boundary or a session hour, so the residue is a rounding of
 * the day's edge, never a placement.
 */
export function isoFromZonedParts(
  ymd: ZonedDateInput,
  hhmm: ZonedTimeInput,
  tz: string,
): string | null {
  requireTz(tz);
  if (!YMD.test(ymd) || !HHMM.test(hhmm)) return null;
  // Rejects a well-shaped impossible date ("2026-02-30"): Date.parse is strict
  // about ISO calendar dates, where the regex above only checks digits.
  if (Number.isNaN(Date.parse(`${ymd}T00:00:00Z`))) return null;
  return new Date(zonedTimeToUtc(ymd, hhmm, tz)).toISOString();
}

/** The instant a `datetime-local` value names in `tz`, as an ISO string. */
export function isoFromZonedDateTime(value: ZonedDateTimeInput, tz: string): string | null {
  // Guarded here as well as in `isoFromZonedParts`: a blank field returns early
  // below, and a missing zone must not be able to hide behind an empty value.
  requireTz(tz);
  const parts = DATETIME_LOCAL.exec(value);
  return parts === null ? null : isoFromZonedParts(parts[1]!, parts[2]!, tz);
}

// ---------------------------------------------------------------------------
// Calendar arithmetic on bare dates
// ---------------------------------------------------------------------------

/** `ymd` plus `days`. Zone-free on purpose — a YMD carries no zone, so a day is
 *  exactly one calendar day here and the zone re-enters only when the result is
 *  turned back into an instant. */
export const addYmdDays = ymdAddDays;

/** Inclusive day count from `first` to `last`, floored at 1. Counted on the
 *  CALENDAR, so a 23- or 25-hour DST day still counts as one — dividing the
 *  millisecond gap would round the spring-forward span down. */
export function ymdSpanDays(first: ZonedDateInput, last: ZonedDateInput): number {
  const a = Date.parse(`${first}T00:00:00Z`);
  const b = Date.parse(`${last}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 1;
  return Math.max(1, Math.round((b - a) / MS_PER_DAY) + 1);
}
