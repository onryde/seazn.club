// A seeded kick-off time that can never be "today", wherever the venue is.
//
// Several surfaces read the real clock against a fixture's `scheduled_at`:
// the run sheet's row action (`fixtureRowAction`, src/lib/fixture-row-action.ts
// — a fixture scheduled TODAY in the venue zone with nobody to score it offers
// "Assign scorer", not "Score") and the division phase (`match_day`, which
// also flips the fixtures tab's default filter to "today"). A spec that seeds a
// LITERAL calendar date for such a fixture is a time bomb: green until the
// calendar reaches it, red for exactly that day. journey-pro.spec.ts seeded
// `Date.UTC(2026, 9, 12, 9, 0, 0)`, written 2026-09-05 as "well past today",
// and main's e2e went red on 2026-10-12 itself.
//
// Pure, with no imports of its own, so the node-env guard
// `src/lib/__tests__/e2e-future-day.test.ts` can import it and sweep it
// against the engine's own `dayKeyInTz` in every IANA zone.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Midnight UTC of the day `daysAhead` whole days after `nowMs`'s UTC day, plus
 * `hourUtc` hours.
 *
 * `daysAhead` must be at least 2. One is NOT enough: at 23:00Z the next UTC
 * day's 09:00Z is 23:00 local in UTC+14 — the same local day as "now" there.
 * Two whole UTC days clear the full -12..+14 offset range at every hour, which
 * the guard proves by sweep rather than by this comment.
 */
export function futureDayUtc(nowMs: number, daysAhead: number, hourUtc: number): number {
  if (!Number.isFinite(nowMs)) throw new RangeError(`futureDayUtc: nowMs must be a finite instant, got ${nowMs}`);
  if (!Number.isInteger(daysAhead) || daysAhead < 2) {
    throw new RangeError(
      `futureDayUtc: daysAhead must be an integer >= 2 (fewer can still be "today" east of UTC), got ${daysAhead}`,
    );
  }
  if (!(hourUtc >= 0 && hourUtc < 24)) throw new RangeError(`futureDayUtc: hourUtc must be in [0, 24), got ${hourUtc}`);
  return Math.floor(nowMs / DAY_MS) * DAY_MS + daysAhead * DAY_MS + hourUtc * HOUR_MS;
}
