// Match Day — the read-time estimate and the candidate order (spec 2026-10-31-match-day-design.md §7, §7.1). Pure and
// client-safe: the read model (server/usecases/match-day.ts) and the call preview (match-day-call.ts) both estimate through
// `estimateQueue`, so a court's "~" times and a call's knock-on can never disagree.
import type { MatchDayCandidate, MatchDayCandidateSource } from "./types";

const MS_PER_MIN = 60_000;

/** A match in a court's queue: its planned start and, when it differs from the queue's, its own length in minutes (a shared
 *  court mixes divisions with different match lengths). */
export interface PlannedMatch {
  id: string;
  planned_at: Date;
  match_minutes?: number;
}

function assertMinutes(m: number, what: string): void {
  if (!Number.isFinite(m) || m <= 0) throw new Error(`estimateQueue: ${what} must be a positive number of minutes, got ${m}`);
}

function assertInstant(d: Date, what: string): void {
  if (Number.isNaN(d.getTime())) throw new Error(`estimateQueue: ${what} is not a valid instant`);
}

/**
 * §7.1: "queue order is the truth; times are estimates". The queue runs in planned order (a tie keeps the order given), and
 * each match's estimated start is max(its planned time, the estimated end of the match before it). The first match's "match
 * before" is whatever holds the court now, which ends at `busyUntil`. A match is never estimated earlier than its plan: a
 * pair is never pulled forward unless the organiser calls them. Each match runs `match_minutes` when it carries one, else
 * `matchMinutes`. Answers each match's estimated start by id; nothing here is ever written (owner ruling B).
 */
export function estimateQueue(
  planned: readonly PlannedMatch[],
  busyUntil: Date,
  matchMinutes: number,
): Map<string, Date> {
  assertMinutes(matchMinutes, "matchMinutes");
  assertInstant(busyUntil, "busyUntil");
  const seen = new Set<string>();
  for (const p of planned) {
    if (seen.has(p.id)) throw new Error(`estimateQueue: match ${p.id} is in the queue twice`);
    seen.add(p.id);
    assertInstant(p.planned_at, `match ${p.id}'s planned time`);
    if (p.match_minutes !== undefined) assertMinutes(p.match_minutes, `match ${p.id}'s length`);
  }
  // Array.prototype.sort is stable: equal planned times keep the order given.
  const order = [...planned].sort((a, b) => a.planned_at.getTime() - b.planned_at.getTime());
  const out = new Map<string, Date>();
  let cursor = busyUntil.getTime();
  for (const p of order) {
    const start = Math.max(p.planned_at.getTime(), cursor);
    out.set(p.id, new Date(start));
    cursor = start + (p.match_minutes ?? matchMinutes) * MS_PER_MIN;
  }
  return out;
}

/** §7's order of the three sources. A `Record`, so a new source is a compile error here rather than an unranked candidate. */
const SOURCE_RANK: Record<MatchDayCandidateSource, number> = { this_court: 0, other_court: 1, no_court: 2 };

/**
 * §7's candidate order: 1. this court's own next match; 2. other courts' matches, most behind first, then the one that would
 * wait longest where it is; 3. matches with no court yet; and every blocked candidate after every free one, in that same order
 * among themselves. Within this court's matches, and within the no-court ones, the order given is kept. A new array; the input
 * is untouched.
 */
export function rankCandidates(c: readonly MatchDayCandidate[]): MatchDayCandidate[] {
  return [...c].sort(
    (a, b) =>
      Number(a.blocked !== null) - Number(b.blocked !== null) ||
      SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
      (a.source === "other_court" ? b.behind_minutes - a.behind_minutes || b.waiting_minutes - a.waiting_minutes : 0),
  );
}
