// The funnel's two calendar days, both read off one server clock in UTC (start-wizard redesign; review-t3 m3, review-t4 m1).
// Pure and client-safe: the /start page, its wizard and the claim all read these two, so they cannot disagree.

const DAY_MS = 86_400_000;
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The server's UTC calendar day: where /start's date chips and its date box begin. */
export function funnelUtcDay(now: Date): string {
  return isoOf(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The earliest first day a funnel event may carry: the UTC day less one, the earliest calendar day any visitor can still
 *  be on. The /start link parser keeps a date from it (a same-day link from west of UTC), and the claim refuses one
 *  before it. */
export function funnelEarliestDay(now: Date): string {
  return isoOf(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS);
}
