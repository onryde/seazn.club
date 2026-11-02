// Match Day — a court's closed windows today (Match Day E2 item 3). Pure and client-safe: it only reads the usable windows the
// scheduler's own availability reader produced (`usableWindows`, engine scheduling/court-windows — exceptions override weekday
// hours, a court with no hours is open all day; the server hands them in), and says where today's CLOSED stretches are. It never
// interprets `court_hours` / `court_exceptions` itself: a second reading of those tables is the fork that module exists to stop.
//
// Times are epoch milliseconds in, ISO strings out (the wire's). `windows` are the court's usable windows on the organisation's
// day, ordered and disjoint (what `usableWindows` returns).
//
// What counts as a closure to SHOW:
//  - closed NOW: `now` is in no window — before the first (the court has not opened yet), in a gap between two, after the last,
//    or the whole day (no window at all). `until` is when it reopens, null when it does not open again today;
//  - closed LATER: `now` is in a window and a LATER window follows it — the gap between them (a lunch break, a bar's hour) is the
//    closure. A court that simply closes for the night is NOT a closure here: that is `past_day_end`'s warning, and a card
//    saying "Closed 22:00–00:00" every evening would be noise.
import type { CallWarning } from "./call";
import type { CourtClosure } from "./types";

/** One usable stretch of a court's day, in epoch ms. */
export interface UsableWindow {
  from: number;
  to: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The window `at` falls in: [from, to). */
const windowAt = (windows: readonly UsableWindow[], at: number): number => windows.findIndex((w) => w.from <= at && at < w.to);

/**
 * The court's closure at `now`, or null while it is open with no break still to come today.
 *  - no windows at all: closed for the day;
 *  - inside a window with another after it: the gap up to that next window;
 *  - outside every window: closed now, reopening at the next window's start (null when none is left).
 */
export function closureOf(windows: readonly UsableWindow[], now: number): CourtClosure | null {
  if (windows.length === 0) return { kind: "now", until: null };
  const at = windowAt(windows, now);
  if (at >= 0) {
    const next = windows[at + 1];
    return next === undefined ? null : { kind: "later", from: iso(windows[at]!.to), until: iso(next.from) };
  }
  const next = windows.find((w) => w.from > now);
  return { kind: "now", until: next === undefined ? null : iso(next.from) };
}

/** Is the court closed at `now`? The one test the Call button and the call preview both ask. */
export const closedNow = (c: { closure: CourtClosure | null }): boolean => c.closure !== null && c.closure.kind === "now";

/**
 * The call preview's closure warning for a match that would run `[start, end)` on this court, or null when it would not meet
 * one (§7.2: a warning, never a refusal — the organiser confirms past it):
 *  - `court_closed`: the court is already closed at `start` (until it reopens, null for the rest of today);
 *  - `crosses_closure`: the court is open at `start` and closes, then reopens, before the match is due to end.
 * A span that outlasts the day's LAST window is `past_day_end`'s, not this one's; a span that ends exactly as the break
 * begins does not cross it.
 */
export function closureWarning(
  windows: readonly UsableWindow[],
  courtName: string,
  start: number,
  end: number,
): Extract<CallWarning, { kind: "crosses_closure" | "court_closed" }> | null {
  const closure = closureOf(windows, start);
  if (closure === null) return null;
  if (closure.kind === "now") return { kind: "court_closed", court_name: courtName, until: closure.until };
  return new Date(closure.from).getTime() < end
    ? { kind: "crosses_closure", court_name: courtName, from: closure.from, until: closure.until }
    : null;
}
