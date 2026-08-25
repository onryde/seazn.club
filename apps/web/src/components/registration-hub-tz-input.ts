// Registration hub config panel — org-timezone datetime-local conversion
// (RS004 W3c, owner decision 1: registration windows are edited and
// displayed in the ORG timezone, with the zone labelled — never
// browser-local, never resolveVenueTz's venue lane).
//
// A `<input type="datetime-local">` always reads/writes a bare
// "YYYY-MM-DDTHH:MM" wall-clock string with no zone of its own. Left alone,
// the browser treats that string as the VISITOR's local time when it renders
// or parses it — wrong here, since the organiser is setting a window for the
// competition in the org's chosen zone, which is very often not the zone the
// organiser happens to be sitting in.
//
// Same fixpoint-over-Intl technique as @seazn/engine/scheduling/tz's
// zonedTimeToUtc (that module's own comment records it verified against all
// 418 IANA zones over 400 consecutive days) — reimplemented locally rather
// than imported: this file is apps/web UI code and this task does not own
// packages/engine, so it does not reach across that boundary for ten lines
// of pure Intl arithmetic.

/** An ISO instant (or Date) -> the wall-clock value a `datetime-local` input
 *  should show, as seen in `tz`. Empty string for null/unparseable input —
 *  never "Invalid Date" leaking into the DOM. */
export function instantToOrgTzInputValue(instant: string | Date | null, tz: string): string {
  if (instant == null) return "";
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (Number.isNaN(ms)) return "";
  return `${dayKeyInTz(ms, tz)}T${hhmmInTz(ms, tz)}`;
}

/** The reverse: a `datetime-local` input's wall-clock value, interpreted in
 *  `tz` -> a UTC ISO instant. Empty string -> null (the field was cleared). */
export function orgTzInputValueToInstant(value: string, tz: string): string | null {
  if (!value) return null;
  const [ymd, hhmm] = value.split("T");
  if (!ymd || !hhmm) return null;
  const ms = zonedTimeToUtcMs(ymd, hhmm.slice(0, 5), tz);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** The calendar day an instant falls on, in `tz`. `en-CA` formats YYYY-MM-DD. */
function dayKeyInTz(instantMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}

/** The wall-clock time of an instant, in `tz`, zero-padded 24h. The `^24`
 *  guard mirrors the engine module's: `hour12: false` can render midnight as
 *  "24:00" on some ICU builds, which would sort after every other time. */
function hhmmInTz(instantMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(instantMs))
    .replace(/^24/, "00");
}

/** Wall clock `(ymd, hh:mm)` in `tz` -> UTC epoch ms. Two correction passes:
 *  the first lands within the offset error, the second fixes the case where
 *  that correction itself crossed a DST boundary. */
function zonedTimeToUtcMs(ymd: string, hhmm: string, tz: string): number {
  const target = Date.parse(`${ymd}T${hhmm}:00Z`);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const wall = Date.parse(`${dayKeyInTz(guess, tz)}T${hhmmInTz(guess, tz)}:00Z`);
    if (wall === target) break;
    guess += target - wall;
  }
  return guess;
}
