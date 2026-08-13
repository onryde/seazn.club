// P3 (D7 news enrichment + weekly digest) — pure helpers, no DB/no I/O, same
// contract discipline as draft-templates.ts's PURE templates: everything here
// is deterministic given its arguments, so the DB-backed assembly in
// org-posts.ts (one impure caller per source, per the design) can unit-test
// the actual math separately from the plumbing that fetches it. A caller that
// wraps EACH of these in its own try/catch gets the fail-open behaviour the
// design requires "for free" — a bad input here throws or returns null, it
// never talks to Postgres.
//
// Zone math is NOT reimplemented here: `dayKeyInTz` / `hhmmInTz` /
// `ymdAddDays` / `zonedTimeToUtc` in the engine are the repo's one DST-correct
// implementation (see apps/web/src/lib/zoned-datetime.ts's header for the
// same rule). `settings.orgTz` is the governing clock — callers resolve it
// via `resolveVenueTz(null, organizations.timezone)`, never `settings.tz`
// (#448, display-only).
import { dayKeyInTz, hhmmInTz, ymdAddDays, zonedTimeToUtc } from "@seazn/engine/scheduling/tz";
import { DASH } from "./draft-templates";

// ---------------------------------------------------------------------------
// Digest window
// ---------------------------------------------------------------------------

export interface DigestWindow {
  /** ISO instant, exclusive-open lower bound. */
  start: string;
  /** ISO instant — the button-press instant itself. */
  end: string;
  /** The org-local calendar date the window STARTS on (the digest's "week of"
   *  label and its `org_posts_auto_once`-adjacent identity — see org-posts.ts). */
  weekOfYmd: string;
}

/**
 * `[now-7d, now)` computed as 7 CALENDAR days earlier at the same wall-clock
 * time in `orgTz` — not a flat 168h subtraction. A week that straddles a DST
 * transition is 167h or 169h of real time, not 168h; this is what "a week
 * ago" means to a human reading the digest in that zone, and it is also the
 * shape the acceptance test pins (spring-forward / fall-back, both
 * directions).
 */
export function digestWindow(nowMs: number, orgTz: string): DigestWindow {
  const ymd = dayKeyInTz(nowMs, orgTz);
  const hhmm = hhmmInTz(nowMs, orgTz);
  const startYmd = ymdAddDays(ymd, -7);
  const startMs = zonedTimeToUtc(startYmd, hhmm, orgTz);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(nowMs).toISOString(),
    weekOfYmd: startYmd,
  };
}

// ---------------------------------------------------------------------------
// Upcoming fixtures, grouped by org-local day
// ---------------------------------------------------------------------------

export interface UpcomingFixture {
  id: string;
  homeName: string;
  awayName: string;
  /** ISO instant — caller has already filtered to fixtures that HAVE one. */
  scheduledAt: string;
  competitionName: string;
  divisionName: string;
}

export interface UpcomingDayGroup {
  dayYmd: string;
  fixtures: UpcomingFixture[];
}

/**
 * Sorts chronologically, caps at `cap` fixtures (design: 10 + an "and N more"
 * tail), then buckets the KEPT fixtures by their ORG-LOCAL calendar day — a
 * bare UTC-date slice would misplace a fixture near a zone offset or DST
 * edge (see the DST test in enrichment.test.ts). Groups are emitted in
 * chronological order (Map preserves first-insertion order, and insertion
 * follows the sorted list).
 */
export function groupUpcomingByDay(
  fixtures: readonly UpcomingFixture[],
  orgTz: string,
  cap = 10,
): { groups: UpcomingDayGroup[]; overflow: number } {
  const sorted = [...fixtures].sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const capped = sorted.slice(0, cap);
  const overflow = Math.max(0, sorted.length - cap);
  const byDay = new Map<string, UpcomingFixture[]>();
  for (const f of capped) {
    const key = dayKeyInTz(Date.parse(f.scheduledAt), orgTz);
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(f);
  }
  return { groups: [...byDay.entries()].map(([dayYmd, fx]) => ({ dayYmd, fixtures: fx })), overflow };
}

// ---------------------------------------------------------------------------
// Standings — biggest climber (digest + round-recap standingsMoves)
// ---------------------------------------------------------------------------

export interface RankedEntrantRow {
  entrantId: string;
  /** Absent when the table has no cascade-broken order for this row yet
   *  (engine's `StandingsRow.rank?`) — such a row cannot be compared. */
  rank?: number;
  points: number;
}

export interface Climber {
  entrantId: string;
  from: number;
  to: number;
}

/**
 * The largest positive rank delta between `previous` and `current` (climbing
 * = a SMALLER rank number). Ties break on points gained; still tied after
 * both -> null (design ruling: an ambiguous "biggest" climber is worse than
 * none, so the line is skipped rather than guessing). An entrant missing
 * from `previous` (newly added to the table) or with no `rank` on either
 * side is excluded from consideration, never thrown on. No `previous`
 * snapshot at all (first-ever computation for this stage) -> null.
 */
export function biggestClimber(
  current: readonly RankedEntrantRow[],
  previous: readonly RankedEntrantRow[] | null | undefined,
): Climber | null {
  if (!previous || previous.length === 0) return null;
  const prevByEntrant = new Map(previous.map((r) => [r.entrantId, r]));
  const candidates: { entrantId: string; from: number; to: number; delta: number; pointsGained: number }[] = [];
  for (const row of current) {
    if (row.rank === undefined) continue;
    const prev = prevByEntrant.get(row.entrantId);
    if (!prev || prev.rank === undefined) continue;
    const delta = prev.rank - row.rank; // positive = climbed toward rank 1
    if (delta <= 0) continue;
    candidates.push({
      entrantId: row.entrantId,
      from: prev.rank,
      to: row.rank,
      delta,
      pointsGained: row.points - prev.points,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.delta - a.delta || b.pointsGained - a.pointsGained);
  const [first, second] = candidates;
  if (second && second.delta === first!.delta && second.pointsGained === first!.pointsGained) return null;
  return { entrantId: first!.entrantId, from: first!.from, to: first!.to };
}

// ---------------------------------------------------------------------------
// Leaderboard diff math (ResultDraftInput.enrichment.leaderboardMoves)
// ---------------------------------------------------------------------------

export interface LeaderboardAfterRow {
  personId: string;
  personName: string;
  /** The person's CURRENT (post-fixture) cumulative metric value. */
  value: number;
}

export interface FixtureContribution {
  personId: string;
  personName: string;
  /** This one fixture's own credit toward the metric — already computed by
   *  the same fold `extractScorers` runs (org-posts.ts), so recomputing it
   *  here would be a second copy of that fold. */
  credit: number;
}

export interface LeaderboardMove {
  personName: string;
  metric: string;
  from: number;
  to: number;
}

/**
 * Rank-before-vs-after for the scorers of ONE just-decided fixture, without
 * needing a persisted stat-history table: `after` is already the current
 * cumulative leaderboard (recompute-on-read), and subtracting a scorer's OWN
 * credit from THIS fixture reconstructs their pre-fixture value — every
 * other player's total is unaffected by a fixture they were not part of, so
 * holding the rest of `after` constant while re-ranking is exact, not an
 * approximation. Competition ranking (rank = 1 + count strictly greater).
 * Omits any scorer whose rank did not actually change, and any contribution
 * that is zero-credit or not found in `after` (fail-open: skip, never throw).
 */
export function computeLeaderboardMoves(
  after: readonly LeaderboardAfterRow[],
  contributions: readonly FixtureContribution[],
  metricLabel: string,
): LeaderboardMove[] {
  const rankOf = (value: number, rows: readonly { value: number }[]): number =>
    1 + rows.filter((r) => r.value > value).length;
  const moves: LeaderboardMove[] = [];
  for (const c of contributions) {
    if (c.credit <= 0) continue;
    const row = after.find((r) => r.personId === c.personId);
    if (!row) continue;
    const beforeValue = row.value - c.credit;
    const beforeRows = after.map((r) => (r.personId === c.personId ? { value: beforeValue } : r));
    const toRank = rankOf(row.value, after);
    const fromRank = rankOf(beforeValue, beforeRows);
    if (fromRank === toRank) continue;
    moves.push({ personName: c.personName, metric: metricLabel, from: fromRank, to: toRank });
  }
  return moves.sort((a, b) => a.to - b.to);
}

// ---------------------------------------------------------------------------
// Streak (ResultDraftInput.enrichment.streak)
// ---------------------------------------------------------------------------

export type ResultOutcome = "win" | "draw" | "loss";

export interface Streak {
  kind: "win" | "unbeaten";
  length: number;
}

/**
 * `resultsNewestFirst[0]` is the fixture that just decided. A win streak
 * counts consecutive wins from the front; an unbeaten streak (win or draw)
 * is reported only when STRICTLY longer than the win streak — otherwise the
 * win streak is the more specific, more newsworthy fact — and only once it
 * reaches 2 (a single draw is not a streak). Null when neither threshold is
 * met (e.g. a lone win, or the run was broken by a loss immediately).
 */
export function computeStreak(resultsNewestFirst: readonly ResultOutcome[]): Streak | null {
  let winLen = 0;
  for (const r of resultsNewestFirst) {
    if (r !== "win") break;
    winLen += 1;
  }
  let unbeatenLen = 0;
  for (const r of resultsNewestFirst) {
    if (r === "loss") break;
    unbeatenLen += 1;
  }
  if (unbeatenLen > winLen && unbeatenLen >= 2) return { kind: "unbeaten", length: unbeatenLen };
  if (winLen >= 2) return { kind: "win", length: winLen };
  return null;
}

// ---------------------------------------------------------------------------
// Biggest result of a round (RoundRecapDraftInput.enrichment.biggestResult)
// ---------------------------------------------------------------------------

export interface RoundResultLine {
  homeName: string;
  homeScore: string;
  awayName: string;
  awayScore: string;
}

/**
 * The result with the largest numeric margin in a round, when BOTH sides'
 * score lines parse as plain non-negative integers. Most sports' `line`
 * values do (football "3", basketball "82"); composite lines like cricket's
 * "252/8 (50)" do not and are silently excluded rather than mis-parsed —
 * designed degradation (Failure matrix), not a bug. A draw (margin 0) is
 * never "biggest". Null when the round has nothing comparable.
 */
export function biggestMargin(results: readonly RoundResultLine[]): { label: string } | null {
  let best: { label: string; margin: number } | null = null;
  for (const r of results) {
    const h = Number(r.homeScore);
    const a = Number(r.awayScore);
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) continue;
    const margin = Math.abs(h - a);
    if (margin === 0) continue;
    if (!best || margin > best.margin) {
      best = { label: `${r.homeName} ${r.homeScore}${DASH}${r.awayScore} ${r.awayName}`, margin };
    }
  }
  return best ? { label: best.label } : null;
}
