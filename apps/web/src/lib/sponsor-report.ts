// The Sponsors hub's Overview period and the sponsor report link's shape (R4 sponsors on stream, S13; spec 2026-10-27 §5.1,
// §5.2). Pure and dependency-free apart from the hub's own URL helper, so the server (`server/sponsors/report.ts`), the
// Overview island and S14's public page all read ONE declaration.
//
// THE PERIOD RULE (controller addendum 2026-11-01; spec §5.1 names the periods and is silent on their edges):
//   - every window is HALF-OPEN in UTC, [from, to): a row exactly at `from` counts, one exactly at `to` does not;
//   - "This year" is 1 Jan 00:00 UTC of `now`'s UTC year to 1 Jan of the next;
//   - "Last 30 days" is LAST_DAYS whole UTC days ending with `now`'s own day (from 00:00 UTC LAST_DAYS-1 days before today, to
//     00:00 UTC tomorrow) - whole days, so a report link, whose bounds are DATES (V483 from_date / to_date), can carry exactly
//     the period the organiser was looking at;
//   - "One competition" has NO time window: it is every airing and click whose fixture is in that competition.
// `now` is always an argument. Nothing here reads the clock.
import { sponsorsHref } from "@/lib/sponsors-hub";

export type SponsorPeriod = { kind: "this_year" } | { kind: "last_30_days" } | { kind: "competition"; competitionId: string };

/** One row of the Overview (server/sponsors/report.ts `sponsorOverview` writes it; the Overview island and S14's page read it).
 *  Declared here, in the client-safe module, so a client component can name it without importing a server file. */
export interface SponsorOverviewRow {
  /** Null for a DELETED sponsor: its airings survive on their name snapshot, and nothing can link to it any more. */
  sponsorId: string | null;
  name: string;
  timesShown: number;
  onScreenMs: number;
  /** Null in PR A (Y1 fills it): shown as a dash, never 0. */
  viewerImpressions: number | null;
  peakViewers: number | null;
  /** Null for a deleted sponsor: its click rows were deleted with it, so the count is unknown, not zero. */
  linkClicks: number | null;
}

/** A live report link as the console lists it: never its token (nobody holds that but the person it was shown to). */
export interface ReportLinkSummary {
  id: string;
  sponsorId: string;
  competitionId: string | null;
  competitionName: string | null;
  /** Inclusive dates, YYYY-MM-DD. */
  from: string;
  to: string;
  createdAt: string;
}

/** What the Share report form opens at: inclusive dates and, for a competition period, that competition. */
export interface ReportLinkDefaults {
  from: string;
  to: string;
  competitionId: string | null;
}

/** "Last 30 days". */
export const LAST_DAYS = 30;

const DAY_MS = 86_400_000;

/** The `?period=` the Overview's picker writes and the page reads. */
export const OVERVIEW_PERIOD_PARAM = "period";

/** A period with a time window: "This year" or "Last 30 days". */
export type TimePeriod = Exclude<SponsorPeriod, { kind: "competition" }>;

/** `[from, to)` in UTC for a time period. An invalid `now` is refused (a NaN window would compare false with every row and
 *  silently report zeros), and so is a kind this rule does not know - it is never read as some other period. */
export function timeWindow(p: TimePeriod, now: Date): { from: Date; to: Date } {
  if (Number.isNaN(now.getTime())) throw new RangeError("sponsor period: `now` is not a valid date");
  const year = now.getUTCFullYear();
  if (p.kind === "this_year") return { from: new Date(Date.UTC(year, 0, 1)), to: new Date(Date.UTC(year + 1, 0, 1)) };
  if (p.kind === "last_30_days") {
    const today = Date.UTC(year, now.getUTCMonth(), now.getUTCDate());
    return { from: new Date(today - (LAST_DAYS - 1) * DAY_MS), to: new Date(today + DAY_MS) };
  }
  throw new RangeError(`sponsor period: unknown kind ${JSON.stringify((p as { kind: unknown }).kind)}`);
}

/** `[from, to)` in UTC for a time period, or null for a competition (no time bound). */
export function periodWindow(p: SponsorPeriod, now: Date): { from: Date; to: Date } | null {
  return p.kind === "competition" ? null : timeWindow(p, now);
}

/** A UTC instant's calendar date, `YYYY-MM-DD`. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The INCLUSIVE dates a report link carries for a whole-day window: its first day, and the day before `to`. */
export function windowDates(w: { from: Date; to: Date }): { from: string; to: string } {
  return { from: isoDay(w.from), to: isoDay(new Date(w.to.getTime() - DAY_MS)) };
}

/** A real calendar date written `YYYY-MM-DD`, and nothing else (no time, no padding slips, no 30 February). */
export function isIsoDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && isoDay(d) === s;
}

/** The period a raw `?period=` names: "last_30_days", one of THIS org's competitions by id, else "This year" (absent,
 *  repeated, unknown, or another org's competition). `find` over the org's own list, never a keyed lookup. */
export function resolveSponsorPeriod(raw: string | string[] | undefined, competitions: readonly { id: string }[]): SponsorPeriod {
  if (typeof raw !== "string") return { kind: "this_year" };
  if (raw === "last_30_days") return { kind: "last_30_days" };
  const competition = competitions.find((c) => c.id === raw);
  return competition ? { kind: "competition", competitionId: competition.id } : { kind: "this_year" };
}

/** The `?period=` value for a period, or null for "This year" (the landing view). */
export function periodParam(p: SponsorPeriod): string | null {
  if (p.kind === "this_year") return null;
  return p.kind === "last_30_days" ? "last_30_days" : p.competitionId;
}

/** The Overview's URL for a period: the hub's bare landing URL for "This year", else with `?period=`. */
export function overviewHref(orgSlug: string, p: SponsorPeriod): string {
  const value = periodParam(p);
  const base = sponsorsHref(orgSlug);
  return value === null ? base : `${base}?${OVERVIEW_PERIOD_PARAM}=${encodeURIComponent(value)}`;
}

/** Spec §5.2: the public report lives at `/r/sponsor/[token]` (S14 builds the page). Root-relative; the console shows it
 *  against the origin the organiser is on. */
export function reportLinkPath(token: string): string {
  return `/r/sponsor/${token}`;
}

/** A `YYYY-MM-DD` date in the reader's locale, read as the UTC calendar day it names (never shifted by the viewer's zone). */
export function fmtIsoDay(locale: string, day: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T00:00:00.000Z`));
}

/** Time on screen to the nearest second - a card holds for seconds, so the house `fmtDuration` (whole minutes) would read
 *  "0 min" for a whole season of lower thirds. Hours, minutes and seconds in Intl's short unit style; empty fields are
 *  omitted, and zero reads as zero seconds. */
export function fmtOnScreen(locale: string, ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const unit = (value: number, u: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "short" }).format(value);
  const parts: string[] = [];
  if (hours > 0) parts.push(unit(hours, "hour"));
  if (minutes > 0) parts.push(unit(minutes, "minute"));
  if (seconds > 0 || parts.length === 0) parts.push(unit(seconds, "second"));
  return parts.join(" ");
}
