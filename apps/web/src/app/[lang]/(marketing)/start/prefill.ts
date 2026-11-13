// /start's query string as the wizard may take it (start-wizard redesign, plan 2026-11-13 Task 3): ONE parser for every
// link into /start. /play's "Or register to start a season" and the home hero send `?sport=<key>` (`tabletennis`); The
// Draw's "Make it real" sends `?sport=Football&entrants=<n>&format=<slug>`; older links send `?sport=<Name>&entrants=<n>
// &date=<day>`. Each field is what the link names or null, never a guess: a sport the funnel does not list, a size the
// start route would refuse, a date that is not a real day still to come, or a format the funnel does not build is dropped
// alone, and the wizard opens that field on its own default. A size is never clamped into range: a link asking for 300
// did not ask for 256.
//
// A repeated param reads its first, as /play's `prefillSport` does, even when the first is garbage. Values are trimmed;
// sport and format are taken in any case. Anything that is not a string is refused, never coerced. The raw value never
// reaches the island. Pure and client-safe.
import { funnelSportByKeyOrName } from "@/lib/funnel-sports";
import { isFunnelFormat, type FunnelFormat } from "@/lib/funnel-formats";
import { isIsoDay } from "@/lib/sponsor-report";

export interface StartPrefill {
  /** A FUNNEL_SPORTS key (`tabletennis`), whether the link named the key or the name. */
  sportKey: string | null;
  entrants: number | null;
  /** `YYYY-MM-DD`, on or after the caller's today. */
  date: string | null;
  format: FunnelFormat | null;
}

/** The field sizes the start route takes (lib/funnel.ts `funnelPayloadSchema.entrants`; the test pins the two). */
const ENTRANTS_MIN = 2;
const ENTRANTS_MAX = 256;

/** A whole number written plainly: digits only, no sign, no leading zero, no exponent, no hex. */
const PLAIN_INT = /^[1-9][0-9]*$/;

/** The first value of a param, trimmed; null when absent or not a string. */
function first(v: unknown): string | null {
  const raw = Array.isArray(v) ? v[0] : v;
  return typeof raw === "string" ? raw.trim() : null;
}

/**
 * `searchParams` (as Next hands a page them) as the wizard's prefill. `today` is the caller's calendar day, `YYYY-MM-DD`:
 * a date before it is dropped. A `today` that is not a real day is refused by name, since every date would then compare
 * against garbage.
 */
export function parseStartPrefill(sp: Record<string, string | string[] | undefined>, today: string): StartPrefill {
  if (!isIsoDay(today)) {
    throw new RangeError(`parseStartPrefill: today must be a YYYY-MM-DD calendar day, got ${JSON.stringify(today)}`);
  }
  const sport = first(sp.sport);
  const entrants = first(sp.entrants);
  const n = entrants !== null && PLAIN_INT.test(entrants) ? Number(entrants) : null;
  const date = first(sp.date);
  const format = first(sp.format)?.toLowerCase() ?? null;
  return {
    sportKey: sport === null ? null : (funnelSportByKeyOrName(sport)?.key ?? null),
    entrants: n !== null && n >= ENTRANTS_MIN && n <= ENTRANTS_MAX ? n : null,
    date: date !== null && isIsoDay(date) && date >= today ? date : null,
    format: isFunnelFormat(format) ? format : null,
  };
}
