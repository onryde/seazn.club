// W5 follow-ups C (owner 2026-11-23, "Ok" on mock 2026-11-23_w5-schedule-paging-options: Option A, "by round"). A BIG schedule
// on a phone - 5,000 matches at the format caps, 45,000-70,000 elements, 11-19 s before it can be used (perf-measure-report P2-P4)
// - is laid out by round: finished rounds collapse into one line, the live round and the next round are open, every other round
// is a folded header whose rows load when it is tapped. The page then carries two rounds of rows whatever the league's size.
//
// This module decides only WHICH rounds start open, from each round's counts. It is pure and status-only (no sport, no clock,
// no layout), and every surface that pages - the public division Schedule, the organiser's run sheet and the hub's Matches tab
// - asks it, so the three agree on what "the live round" and "the next round" are. Grouping fixtures INTO rounds is each
// surface's own (a public round is named by the round namer, an organiser's bar by its number).
import { LOCKED_FIXTURE_STATUSES, SETTLED_FIXTURE_STATUSES, FIXTURE_STATUSES } from "./fixture-status";

/** A schedule pages by round only when its division holds MORE than this many fixtures (owner's brief: "big schedules on
 *  phones"). At or below it every surface renders exactly as before - a small league's whole season is one screenful, and
 *  folding it would cost taps for nothing. 200 rows is about 2,000-3,000 elements on any of the three surfaces. */
export const ROUND_PAGING_MIN_FIXTURES = 200;

/** Does a division with `fixtureCount` fixtures page by round? */
export function pagesByRound(fixtureCount: number): boolean {
  return fixtureCount > ROUND_PAGING_MIN_FIXTURES;
}

/** The chip a match sits under: All / Live / Upcoming / Results. */
export type RoundBucket = "live" | "upcoming" | "result";
export type RoundBuckets = Record<RoundBucket, number>;

const KNOWN_STATUSES: ReadonlySet<string> = new Set(FIXTURE_STATUSES);

/**
 * Which chip a fixture of this status sits under. `in_play` is live; a settled match (a result, a walkover, an abandonment), a
 * locked one (finalized, or cancelled - a void) and a HELD level bracket match (`needs_decision`: played, the public row reads it
 * Ended) are results; everything else - only `scheduled` today - is upcoming. A status the schema does not have is refused by
 * name: filing it under a chip would put a match nobody can classify under one.
 */
export function fixtureBucket(status: string): RoundBucket {
  if (!KNOWN_STATUSES.has(status)) throw new Error(`ROUND_PAGING_UNKNOWN_STATUS: ${status}`);
  if (status === "in_play") return "live";
  if (SETTLED_FIXTURE_STATUSES.has(status) || LOCKED_FIXTURE_STATUSES.has(status) || status === "needs_decision") return "result";
  return "upcoming";
}

/** Count a round's fixtures by chip. */
export function bucketCounts<F>(fixtures: readonly F[], statusOf: (f: F) => string): RoundBuckets {
  const out: RoundBuckets = { live: 0, upcoming: 0, result: 0 };
  for (const f of fixtures) out[fixtureBucket(statusOf(f))] += 1;
  return out;
}

/**
 * A round's state, as its header says it:
 * - `finished`: every match a result;
 * - `live`: a match in play;
 * - `inProgress`: some played, some still to play, none in play (the current round between matches, or a round with a
 *   postponed match behind the live one);
 * - `next`: the first round still to play after the last round anything has happened in;
 * - `upcoming`: any later round.
 */
export type RoundState = "finished" | "live" | "inProgress" | "next" | "upcoming";

export interface PlannedRound extends RoundBuckets {
  key: string;
  state: RoundState;
  /** Starts open: its rows ship with the page. Every other round is a header; its rows load on a tap. */
  open: boolean;
  total: number;
}

/**
 * Plan a schedule's rounds, given IN PLAY ORDER. Open: every live round, the current round when it is part-played with nothing
 * live, and the next round - the first round still to play after the last round anything has been played or is being played in
 * (the frontier). A part-played round BEHIND the frontier (a postponed match) stays folded while a round after the frontier is still
 * to play: it must never take "next" from the round that really is next. When nothing after the frontier is to play, the earliest
 * round still holding a match to play is next (review N3: a postponed match behind a fully played last round). When nothing is
 * left to play at all, the last round opens, so a finished schedule still shows its ending.
 * The empty schedule plans nothing.
 *
 * A CATCH-UP round (`catchUp`: a late entrant's appended round, `isCatchUpRoundExtKey`, numbered after the draw's last round but
 * played alongside the season) never marks how far the season has come (review C2): the frontier, "next" and the finished
 * schedule's ending are read off the draw's own rounds. A catch-up round opens only while it is live or part-played, and is
 * "next" only once its stage's drawn rounds have nothing left to play.
 */
export function planRounds(rounds: readonly { key: string; buckets: RoundBuckets; catchUp?: boolean }[]): PlannedRound[] {
  if (rounds.length === 0) return [];
  for (const r of rounds) {
    if (r.buckets.live + r.buckets.upcoming + r.buckets.result === 0) throw new Error(`ROUND_PAGING_EMPTY_ROUND: ${r.key}`);
  }
  const drawn = (i: number) => rounds[i]!.catchUp !== true;
  let frontier = -1;
  rounds.forEach((r, i) => {
    if (drawn(i) && (r.buckets.live > 0 || r.buckets.result > 0)) frontier = i;
  });
  // The next round: the first round after the frontier with a match still to play. A drawn round is never live after the frontier
  // (the frontier is the LAST drawn round with anything played or in play). Catch-up rounds sit after their stage's drawn rounds, so
  // one is "next" only once its stage's draw has nothing left to play - and then before a later stage's first round, which cannot
  // start until they are played.
  let next = -1;
  for (let i = frontier + 1; i < rounds.length; i++) {
    if (rounds[i]!.buckets.upcoming > 0) {
      next = i;
      break;
    }
  }
  // Review N3: nothing after the frontier is to play, yet a round BEHIND it still holds a match to play (postponed, rearranged). It
  // is the next thing the season plays - the earliest such round is "next" and opens, before the finished ending is considered.
  if (next === -1) next = rounds.findIndex((r) => r.buckets.upcoming > 0);
  const stateOf = (r: { buckets: RoundBuckets }, i: number): RoundState => {
    const b = r.buckets;
    if (b.live > 0) return "live";
    if (b.upcoming === 0) return "finished";
    if (i === next) return "next";
    if (b.result > 0) return "inProgress";
    return "upcoming";
  };
  const planned = rounds.map((r, i): PlannedRound => {
    const state = stateOf(r, i);
    // The current round: the frontier itself, part-played with nothing live - or a catch-up round part-played.
    const current = state === "inProgress" && (i === frontier || !drawn(i));
    return {
      key: r.key,
      state,
      open: state === "live" || state === "next" || current,
      total: r.buckets.live + r.buckets.upcoming + r.buckets.result,
      ...r.buckets,
    };
  });
  if (!planned.some((r) => r.open)) {
    // Nothing left to play: the draw's last round is the schedule's ending (a catch-up only when the draw has none).
    let last = planned.length - 1;
    for (let i = planned.length - 1; i >= 0; i--) {
      if (drawn(i)) {
        last = i;
        break;
      }
    }
    planned[last]!.open = true;
  }
  return planned;
}
