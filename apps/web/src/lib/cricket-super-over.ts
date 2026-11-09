// The deciding super over, read once for every surface that shows it.
//
// Under the engine's "repeat" policy a tied super over is played again, so only
// the LAST super over decides, and it is the one a spectator wants. This module
// is the web's single reading of "the last super over", pure and
// dependency-free so the match centre header and the poster cannot drift on
// what it means.
//
// A super over is a PAIR of innings, one per side, in the order they were
// played (`state.superOver.innings`, `card.innings` with `isSuperOver`). The
// last pair is the last two entries, or the last one while its second half is
// still to come.

export type SuperOverInnings = {
  /** An opaque side id: "home"/"away" off the fold's state, an entrant id off the scorecard. */
  readonly side: string;
  readonly runs: number;
  readonly wickets: number;
};

export type LastSuperOver = {
  /** 1-based: the third super over is 3. */
  readonly number: number;
  /** How many super overs have been started, this one included. */
  readonly count: number;
  /** One innings while the second half is still to come, else two; in batting order. */
  readonly innings: readonly SuperOverInnings[];
};

/** The last super over of a list of super-over innings in play order, or null when none has started. */
export function lastSuperOver(list: readonly SuperOverInnings[]): LastSuperOver | null {
  if (list.length === 0) return null;
  const count = Math.ceil(list.length / 2);
  return { number: count, count, innings: list.slice((count - 1) * 2) };
}

/** "36/0" — the innings format every surface already uses, minus the overs. */
export function inningsScore(innings: Pick<SuperOverInnings, "runs" | "wickets">): string {
  return `${innings.runs}/${innings.wickets}`;
}
