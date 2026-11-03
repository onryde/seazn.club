// A venue zone in which the real clock reads local MIDDAY, and seeded times that cannot leave that day.
//
// Several Match Day specs seed fixtures "today, near now" (a match planned 20 minutes ago, one in 45, one in two hours) and then read
// the board. "Today" for a division is its schedule-settings zone's day, so a seed that plans in UTC and clamps to the UTC day
// (`Math.min(dayStart + 86_400_000 - 60_000, ...)`) is only honest while the run starts at least two hours before UTC midnight: at 23:55Z
// every future offset clamps to the same 23:59 instant, the matches tie, and the board's order and its "Next on <court>" lines are no
// longer the ones the test derives from the offsets (CI run 41548545074, 2026-11-03, "E2 items 1, 2, 3, 5, 7 (desktop)").
//
// The offsets are not the free variable; THE ZONE IS. The division's schedule-settings `tz` is chosen by the seed, so choosing the
// zone where "now" is local midday puts ~12 hours of room on each side of the day boundary at every hour of the real clock, and the
// offsets can stay as large and as honest as they are. (`run-sheet.spec.ts` made the same move for the run sheet: `middayZoneFor`
// there, amendment 4.) The ORGANISATION's zone, which labels the Match Day page and times the courts' opening hours, is untouched.
//
// `Etc/GMT±N` is POSIX-style and INVERTS THE SIGN: `Etc/GMT-5` is UTC+5. They are fixed-offset and DST-free on purpose, so a real zone's
// seasonal shift cannot move the midday anchor out from under the seed.
//
// Pure, with no imports of its own, so the node-env guard `src/lib/__tests__/e2e-midday-zone.test.ts` can import it and sweep it
// against the platform's own calendar (the `future-day.ts` pattern).

/** The `Etc/GMT±N` zone (or "UTC") in which `nowMs` is 12:xx local. */
export function middayZoneFor(nowMs: number): string {
  if (!Number.isFinite(nowMs)) throw new RangeError(`middayZoneFor: nowMs must be a finite instant, got ${nowMs}`);
  const offsetHours = 12 - new Date(nowMs).getUTCHours();
  if (offsetHours === 0) return "UTC";
  return `Etc/GMT${offsetHours > 0 ? "-" : "+"}${Math.abs(offsetHours)}`;
}

/** The calendar day of an instant in a zone, as YYYY-MM-DD. */
export function localDay(instantMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instantMs));
}

/**
 * `within(offsetMin)`: the ISO instant `offsetMin` minutes from `nowMs`, REFUSING one that falls on another day of `tz` than `nowMs` does.
 * With `tz = middayZoneFor(nowMs)` that never happens for any offset under eleven hours; the refusal is the guard for the day someone
 * passes a larger offset, or a different zone, and would otherwise get a silent tie or a match planned for tomorrow.
 */
export function withinToday(nowMs: number, tz: string): (offsetMin: number) => string {
  const day = localDay(nowMs, tz);
  return (offsetMin: number): string => {
    const at = nowMs + offsetMin * 60_000;
    if (localDay(at, tz) !== day) {
      throw new RangeError(
        `withinToday: ${offsetMin} min from ${new Date(nowMs).toISOString()} is not on ${day} in ${tz} - plan in middayZoneFor(now) so the run has room on both sides of the day`,
      );
    }
    return new Date(at).toISOString();
  };
}
